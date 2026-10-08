/** Printing slug after `/cards/:id/` on a public or router card path. */

export function printingSlugFromCanonicalPath(path) {
  const match = String(path || '').split(/[?#]/)[0].match(/\/cards\/\d+\/([^/]+)/);
  return match ? match[1] : '';
}
