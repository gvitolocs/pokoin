import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { carryReleaseChunks, chunkRefs, listChunks, MANIFEST, planCarry } from './carry-web-release-chunks.mjs';

const FROM = 'https://pokoin.test';

function distWith(files) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-'));
  for (const file of files) {
    const target = path.join(dist, 'market/s', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `own ${file}`);
  }
  return dist;
}

/** A fake live site: path → body; everything else 404. */
function liveSite(files) {
  const requests = [];
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    requests.push(pathname);
    if (!(pathname in files)) return new Response('Not Found', { status: 404 });
    const body = files[pathname];
    if (body instanceof Error) return new Response('boom', { status: 502 });
    return new Response(body, { status: 200 });
  };
  return { fetchImpl, requests };
}

const quiet = () => {};

test('chunkRefs finds shell, sibling import, and mapDeps references', () => {
  const html = '<script type="module" crossorigin src="/market/s/index-DtT5jbjK.js"></script>'
    + '<link rel="stylesheet" href="/market/s/index-CrKO1uXj.css">';
  assert.deepEqual(chunkRefs(html).sort(), ['index-CrKO1uXj.css', 'index-DtT5jbjK.js']);
  const chunk = 'import{a}from"./order-status-CnF-wzFs.js";U(()=>import(`./Card-B1_x.js`),'
    + 'm.f=["s/suggest-live-D1Wwphyi.js","s/x-A.css"]);url(/home/satoshi.woff2)';
  assert.deepEqual(chunkRefs(chunk).sort(), ['Card-B1_x.js', 'order-status-CnF-wzFs.js', 'suggest-live-D1Wwphyi.js', 'x-A.css']);
});

test('planCarry keeps the last releases and skips files the new build already has', () => {
  const previous = [
    { release: 'b', files: ['index-B.js', 'shared-1.js'] },
    { release: 'a', files: ['index-A.js', 'shared-1.js'] },
    { release: 'z', files: ['index-Z.js'] },
  ];
  const { kept, carry } = planCarry(['index-C.js', 'shared-1.js'], previous, 2);
  assert.deepEqual(kept.map((row) => row.release), ['b', 'a']);
  assert.deepEqual(carry, ['index-A.js', 'index-B.js']);
  assert.deepEqual(planCarry(['x.js'], previous, 0).carry, []);
});

test('carries the live manifest releases into the upload and writes the new manifest', async () => {
  const dist = distWith(['index-C.js', 'shared-1.js']);
  const manifest = {
    version: 1,
    releases: [
      { release: 'b', files: ['index-B.js', 'shared-1.js', 'gone-B.js'] },
      { release: 'a', files: ['index-A.js'] },
      { release: 'z', files: ['index-Z.js'] },
    ],
  };
  const { fetchImpl, requests } = liveSite({
    [`/${MANIFEST}`]: JSON.stringify(manifest),
    '/market/s/index-B.js': 'live B',
    '/market/s/index-A.js': 'live A',
    '/market/s/index-Z.js': 'live Z',
  });
  const result = await carryReleaseChunks({ dist, release: 'c', from: FROM, keep: 2, fetchImpl, log: quiet });
  assert.equal(result.carried, 2);
  assert.deepEqual(result.missing, ['gone-B.js']);
  assert.deepEqual(result.releases, ['c', 'b', 'a']);
  assert.equal(fs.readFileSync(path.join(dist, 'market/s/index-B.js'), 'utf8'), 'live B');
  assert.equal(fs.readFileSync(path.join(dist, 'market/s/index-A.js'), 'utf8'), 'live A');
  // Own files are never overwritten by the live copy; dropped releases are not fetched.
  assert.equal(fs.readFileSync(path.join(dist, 'market/s/shared-1.js'), 'utf8'), 'own shared-1.js');
  assert.equal(fs.existsSync(path.join(dist, 'market/s/index-Z.js')), false);
  assert.equal(requests.includes('/market/s/index-Z.js'), false);
  assert.equal(requests.includes('/market/s/shared-1.js'), false);

  const written = JSON.parse(fs.readFileSync(path.join(dist, MANIFEST), 'utf8'));
  assert.deepEqual(written.releases, [
    { release: 'c', files: ['index-C.js', 'shared-1.js'] },
    { release: 'b', files: ['index-B.js', 'shared-1.js'] },
    { release: 'a', files: ['index-A.js'] },
  ]);
  // The manifest sits outside /market/s, so it is not itself carried as a chunk.
  assert.deepEqual(listChunks(dist), ['index-A.js', 'index-B.js', 'index-C.js', 'shared-1.js']);
});

test('without a live manifest the chunk list is crawled from the live shell', async () => {
  const dist = distWith(['index-N.js']);
  const { fetchImpl } = liveSite({
    '/market/app': '<script type="module" src="/market/s/index-O.js"></script><link rel="stylesheet" href="/market/s/index-O.css">',
    '/market/s/index-O.js': 'import"./lazy-O.js";m.f=["s/deep-O.js"];import(`./ghost.js`)',
    '/market/s/index-O.css': 'a{}',
    '/market/s/lazy-O.js': 'export{}',
    '/market/s/deep-O.js': 'import"./index-O.js"',
  });
  const result = await carryReleaseChunks({ dist, release: 'n', from: FROM, keep: 2, fetchImpl, log: quiet });
  assert.deepEqual(listChunks(dist), ['deep-O.js', 'index-N.js', 'index-O.css', 'index-O.js', 'lazy-O.js']);
  assert.equal(result.carried, 4);
  const written = JSON.parse(fs.readFileSync(path.join(dist, MANIFEST), 'utf8'));
  assert.deepEqual(written.releases.map((row) => row.release), ['n', 'live']);
  assert.deepEqual(written.releases[1].files, ['deep-O.js', 'index-O.css', 'index-O.js', 'lazy-O.js']);
});

test('a redeploy of the live release does not push older releases out', async () => {
  const dist = distWith(['index-B.js']);
  const { fetchImpl } = liveSite({
    [`/${MANIFEST}`]: JSON.stringify({ version: 1, releases: [
      { release: 'b', files: ['index-B.js'] },
      { release: 'a', files: ['index-A.js'] },
    ] }),
    '/market/s/index-A.js': 'live A',
  });
  const result = await carryReleaseChunks({ dist, release: 'b', from: FROM, keep: 2, fetchImpl, log: quiet });
  assert.deepEqual(result.releases, ['b', 'a']);
  assert.equal(result.carried, 1);
});

test('an origin error fails the carry instead of shipping without the old chunks', async () => {
  const dist = distWith(['index-C.js']);
  const { fetchImpl } = liveSite({
    [`/${MANIFEST}`]: JSON.stringify({ version: 1, releases: [{ release: 'b', files: ['index-B.js'] }] }),
    '/market/s/index-B.js': new Error('502'),
  });
  await assert.rejects(
    carryReleaseChunks({ dist, release: 'c', from: FROM, keep: 2, fetchImpl, log: quiet }),
    /HTTP 502/,
  );
  await assert.rejects(
    carryReleaseChunks({ dist, release: '', from: FROM, fetchImpl, log: quiet }),
    /--release/,
  );
});
