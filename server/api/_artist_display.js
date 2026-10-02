function cleanText(value, maxLength = 160) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeArtistLookupName(value) {
  return cleanText(value, 180)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeArtistSlug(value) {
  return cleanText(value, 180)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const DISPLAY_NAME_OVERRIDES = new Map([
  ['2017 pikachu project', 'Pikachu Project'],
  ['pikachu project 2017', 'Pikachu Project'],
]);

const SLUG_ALIASES = new Map([
  ['2017-pikachu-project', ['2017-pikachu-project', 'pikachu-project-2017']],
  ['pikachu-project', ['pikachu-project', '2017-pikachu-project', 'pikachu-project-2017']],
  ['pikachu-project-2017', ['pikachu-project-2017', '2017-pikachu-project']],
]);

const LOOKUP_NAME_ALIASES = new Map([
  ['2017 pikachu project', ['2017 pikachu project', 'pikachu project 2017']],
  ['pikachu project', ['pikachu project', '2017 pikachu project', 'pikachu project 2017']],
  ['pikachu project 2017', ['pikachu project 2017', '2017 pikachu project']],
]);

function uniqueValues(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const clean = cleanText(value);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
  }
  return result;
}

function titleFromNormalizedArtist(value) {
  return normalizeArtistLookupName(value)
    .split(' ')
    .filter(Boolean)
    .map((part) => (part.length <= 1 ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1)}`))
    .join(' ');
}

function displayNameForArtist({
  normalizedArtist,
  profileDisplayName,
  fallbackName,
} = {}) {
  const normalized = normalizeArtistLookupName(normalizedArtist);
  const override = DISPLAY_NAME_OVERRIDES.get(normalized);
  if (override) return override;

  const cleanProfileName = cleanText(profileDisplayName);
  if (cleanProfileName) return cleanProfileName;

  return cleanText(fallbackName) || titleFromNormalizedArtist(normalized);
}

function slugAliasesForArtistSlug(value) {
  const slug = normalizeArtistSlug(value);
  if (!slug) return [];
  return uniqueValues([slug, ...(SLUG_ALIASES.get(slug) || [])]);
}

function lookupAliasesForArtistName(value) {
  const name = normalizeArtistLookupName(value);
  if (!name) return [];
  return uniqueValues([name, ...(LOOKUP_NAME_ALIASES.get(name) || [])]);
}

function applyArtistDisplayNameToRow(row = {}) {
  const displayName = displayNameForArtist({
    normalizedArtist: row.normalized_artist,
    profileDisplayName: row.profile_display_name,
    fallbackName: row.artist || row.illustrator,
  });
  const normalizedArtist = normalizeArtistLookupName(row.normalized_artist);
  const illustratorMatchesArtist =
    !row.illustrator || normalizeArtistLookupName(row.illustrator) === normalizedArtist;

  return {
    ...row,
    artist: displayName || row.artist || row.illustrator || '',
    illustrator: illustratorMatchesArtist
      ? displayName || row.illustrator || row.artist || ''
      : row.illustrator,
    artist_display_name: displayName,
  };
}

module.exports = {
  applyArtistDisplayNameToRow,
  displayNameForArtist,
  lookupAliasesForArtistName,
  normalizeArtistLookupName,
  normalizeArtistSlug,
  slugAliasesForArtistSlug,
};
