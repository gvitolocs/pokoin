function foldDiacritics(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function slugPart(value) {
  return foldDiacritics(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeLegacyPokemonSlugParts(parts) {
  const normalized = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === 'pok' && parts[index + 1] === 'mon') {
      normalized.push('pokemon');
      index += 1;
    } else {
      normalized.push(parts[index]);
    }
  }
  return normalized;
}

function slugParts(value) {
  const slug = slugPart(value);
  return slug ? normalizeLegacyPokemonSlugParts(slug.split('-').filter(Boolean)) : [];
}

module.exports = {
  foldDiacritics,
  normalizeLegacyPokemonSlugParts,
  slugPart,
  slugParts,
};
