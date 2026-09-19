import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

test('explorer.pokoin.com routes to the vendored explorer UI, never the marketplace', () => {
  const config = readJson(`${repoRoot}vercel.json`);
  const host = 'explorer.pokoin.com';
  const rules = config.rewrites.filter((rule) => (
    (rule.has || []).some((condition) => condition.type === 'host' && condition.value === host)
  ));
  const rootRule = rules.find((rule) => rule.source === '/');
  const catchAll = rules.find((rule) => rule.source === '/:path*');
  assert.ok(rootRule, 'explorer host needs a root rewrite');
  assert.equal(rootRule.destination, '/explorer/index.html');
  assert.ok(catchAll, 'explorer host needs a catch-all rewrite');
  assert.equal(catchAll.destination, '/explorer/:path*');
  for (const rule of rules) {
    assert.ok(
      rule.destination.startsWith('/explorer/'),
      `explorer host rule must stay inside /explorer/, got ${rule.destination}`,
    );
  }
  // No SPA/landing rule may claim the explorer host.
  for (const rule of config.rewrites) {
    if ((rule.has || []).some((condition) => condition.type === 'host' && condition.value === host)) {
      continue;
    }
    assert.ok(
      !rule.destination.includes('explorer'),
      `non-explorer rule leaks explorer paths: ${rule.source} -> ${rule.destination}`,
    );
  }
});

test('build-web.sh copies the vendored explorer UI into dist-web', () => {
  const buildScript = fs.readFileSync(`${repoRoot}scripts/build-web.sh`, 'utf8');
  assert.match(buildScript, /cp -a "\$ROOT\/explorer" "\$OUT\/explorer"/);
  // The vendored UI must exist in the repo so the build cannot silently 404.
  const explorerIndex = fs.readFileSync(`${repoRoot}explorer/index.html`, 'utf8');
  assert.match(explorerIndex, /app\.js/);
  assert.ok(fs.existsSync(`${repoRoot}explorer/styles.css`));
  assert.ok(fs.existsSync(`${repoRoot}explorer/pokoin-logo.png`));
});

test('wpkn token-listing logo ships at the documented path and size', () => {
  const logo = fs.readFileSync(`${repoRoot}explorer/wpkn/logo.png`);
  // PNG magic + IHDR width/height at bytes 16..24.
  assert.deepEqual([...logo.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(logo.readUInt32BE(16), 256);
  assert.equal(logo.readUInt32BE(20), 256);
  // Same mark as the marketplace logo (both are 512x512 sources downscaled).
  assert.ok(logo.length > 4000, 'logo should not be a blank placeholder');
});
