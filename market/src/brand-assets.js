/**
 * URL of a file in market/public/brand/. The production build serves the
 * marketplace's public files under /market/ (vite base), dev under /, so
 * never hard-code "/brand/…" in a page.
 */
export function brandSrc(path) {
  const base = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}brand/${String(path || '').replace(/^\/+/, '')}`;
}
