/** Catalog hub links (footer Catalog menu, phone drawer chips). No React. */
export function catalogLinks(lang = 'en') {
  const language = String(lang || 'en').toLowerCase() || 'en';
  return [
    { to: `/marketplace/${language}/pokemon`, label: 'Pokémon' },
    { to: '/marketplace/sets', label: 'Sets' },
    { to: '/marketplace/eras', label: 'Eras' },
    { to: `/marketplace/${language}/artists`, label: 'Artists' },
    { to: `/marketplace/${language}/rarities`, label: 'Rarities' },
    { to: `/marketplace/${language}/languages`, label: 'Languages' },
    { to: `/marketplace/${language}/guides`, label: 'Guides' },
  ];
}

const EXTRA = new Set(['Eras', 'Rarities', 'Languages', 'Guides']);

/** The footer Catalog disclosure lists only the hubs the Shop column does not. */
export function catalogMenuLinks(lang = 'en') {
  return catalogLinks(lang).filter((row) => EXTRA.has(row.label));
}
