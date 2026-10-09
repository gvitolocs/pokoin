/**
 * The pages a marketplace visit usually opens next — the card desk and search —
 * load on idle. Router 2 holds a navigation until the lazy route code is ready,
 * so without this a tile click kept the old screen (and the old URL) while the
 * desk chunk downloaded. Skipped on Save-Data / 2g, like the router's own
 * viewport and eager preloads.
 */
export function warmLikelyRoutes() {
  const connection = typeof navigator === 'undefined' ? null : navigator.connection;
  if (connection?.saveData || /(^|-)2g$/.test(String(connection?.effectiveType || ''))) return;
  import('../pages/Card.jsx').catch(() => {});
  import('../pages/Search.jsx').catch(() => {});
}
