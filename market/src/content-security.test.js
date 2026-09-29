import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function executableInlineScripts(html) {
  const blocks = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  return blocks.filter((block) => {
    const open = block.match(/^<script\b[^>]*>/i)[0];
    if (/\ssrc\s*=/.test(open)) return false;
    const type = open.match(/\stype\s*=\s*["']([^"']+)["']/i);
    if (type && type[1] !== 'module' && !/javascript/i.test(type[1])) return false;
    return true;
  });
}

test('landing and marketplace boot from same-origin files', () => {
  const landing = readFileSync(join(root, 'index.html'), 'utf8');
  const market = readFileSync(join(root, 'market/index.html'), 'utf8');
  assert.equal(executableInlineScripts(landing).length, 0);
  assert.equal(executableInlineScripts(market).length, 0);
  assert.match(landing, /src="home\/landing-boot\.js"/);
  assert.match(market, /src="%BASE_URL%card-url-boot\.js"/);
  assert.equal(readFileSync(join(root, 'home/landing-boot.js'), 'utf8').includes('cookies-ok'), true);
  assert.equal(readFileSync(join(root, 'market/public/card-url-boot.js'), 'utf8').includes('marketplace-card-url'), true);
});

test('content security policy allows first-party scripts and Firebase sign-in', () => {
  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
  const rule = vercel.headers.find((entry) => entry.headers.some((row) => row.key === 'Content-Security-Policy'));
  const policy = rule.headers.find((entry) => entry.key === 'Content-Security-Policy').value;
  assert.match(policy, /base-uri 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'self'/);
  assert.match(policy, /script-src 'self' https:\/\/apis\.google\.com https:\/\/www\.gstatic\.com https:\/\/www\.google\.com https:\/\/accounts\.google\.com https:\/\/pokoin\.firebaseapp\.com/);
  assert.equal(policy.includes('unsafe-inline'), false);
  assert.equal(policy.includes('unsafe-eval'), false);
});

test('Firebase auth handler pages are left out of the site policy', () => {
  // /__/auth/handler is Firebase's page proxied from pokoin.firebaseapp.com;
  // its inline init script is blocked by script-src and Google sign-in
  // stays on a blank page.
  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
  const withPolicy = vercel.headers.filter((entry) => entry.headers.some((row) => row.key === 'Content-Security-Policy'));
  assert.equal(withPolicy.length, 1);
  const matches = new RegExp(`^${withPolicy[0].source}$`);
  for (const path of ['/__/auth/handler', '/__/auth/iframe', '/__/firebase/init.json']) {
    assert.equal(matches.test(path), false, path);
  }
  for (const path of ['/', '/marketplace', '/auth', '/profile', '/marketplace/en/cards/249662']) {
    assert.equal(matches.test(path), true, path);
  }
  assert.ok(vercel.rewrites.some((row) => row.source === '/__/auth/:path*'));
});
