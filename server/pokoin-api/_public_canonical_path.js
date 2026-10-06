'use strict';

/** Public card path. Pokémon stays unprefixed. Router paths stay unprefixed. */
function publicCanonicalPath(path, slug) {
  const raw = String(path || '').trim();
  const prefix = String(slug || '').replace(/^\/+|\/+$/g, '');
  if (!raw || !prefix) return raw;
  if (raw === `/${prefix}` || raw.startsWith(`/${prefix}/`)) return raw;
  return raw.startsWith('/') ? `/${prefix}${raw}` : `/${prefix}/${raw}`;
}

module.exports = {
  publicCanonicalPath,
};
