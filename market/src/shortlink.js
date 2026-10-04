/**
 * Numeric card short links inside the router basename: /239324 and
 * /239324/some-slug. On a game prefix (pokoin.com/riftbound/661762, the target
 * of the old riftbound.pokoin.com/{id} links) the router sees /661762 and used to
 * fall through to the marketplace home. Returns the card desk path, or '' for
 * any other path.
 */
export function shortlinkCardPath(pathname) {
  const match = /^\/(\d{1,12})(?:\/([a-z0-9][a-z0-9-]*))?\/?$/i.exec(String(pathname || ''));
  if (!match) return '';
  return `/marketplace/en/cards/${match[1]}${match[2] ? `/${match[2]}` : ''}`;
}
