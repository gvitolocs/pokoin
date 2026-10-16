/**
 * Bare "board" paths: test.pokoin.com review
 * boards and the extension sign-in bridge render bare — no header, cookie
 * notice, chat dock or origin-down page — and stay on the legacy dashboard host.
 */
const BARE = new Set([
  '/tests',
  '/sanitize',
  '/espurr',
  '/ocr',
  '/ocr/artists',
  '/artwork',
  '/jumbos',
  '/poko',
  '/poko/archive',
  '/extension/auth-bridge',
]);

export function isBarePath(pathname) {
  return BARE.has(String(pathname || '').replace(/\/$/, ''));
}
