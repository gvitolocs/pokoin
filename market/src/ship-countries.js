/** ISO ship-from countries for seller settings + listing country chips. */

export const SHIP_FROM_COUNTRIES = [
  { code: 'AT', name: 'Austria' },
  { code: 'BE', name: 'Belgium' },
  { code: 'BG', name: 'Bulgaria' },
  { code: 'HR', name: 'Croatia' },
  { code: 'CY', name: 'Cyprus' },
  { code: 'CZ', name: 'Czechia' },
  { code: 'DK', name: 'Denmark' },
  { code: 'EE', name: 'Estonia' },
  { code: 'FI', name: 'Finland' },
  { code: 'FR', name: 'France' },
  { code: 'DE', name: 'Germany' },
  { code: 'GR', name: 'Greece' },
  { code: 'HU', name: 'Hungary' },
  { code: 'IE', name: 'Ireland' },
  { code: 'IT', name: 'Italy' },
  { code: 'LV', name: 'Latvia' },
  { code: 'LT', name: 'Lithuania' },
  { code: 'LU', name: 'Luxembourg' },
  { code: 'MT', name: 'Malta' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'PL', name: 'Poland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'RO', name: 'Romania' },
  { code: 'SK', name: 'Slovakia' },
  { code: 'SI', name: 'Slovenia' },
  { code: 'ES', name: 'Spain' },
  { code: 'SE', name: 'Sweden' },
];

const NAME_BY_CODE = Object.fromEntries(
  SHIP_FROM_COUNTRIES.map((row) => [row.code, row.name]),
);

/** Regional-indicator emoji for an ISO 3166-1 alpha-2 code (🇬🇧 for GB/UK). */
export function countryFlagEmoji(code) {
  const raw = String(code || '').trim().toUpperCase();
  const iso = raw === 'UK' ? 'GB' : raw;
  if (!/^[A-Z]{2}$/.test(iso) || iso === 'EU') return '';
  const base = 0x1F1E6;
  return String.fromCodePoint(
    base + iso.charCodeAt(0) - 65,
    base + iso.charCodeAt(1) - 65,
  );
}

export function shipFromCountryName(code) {
  const raw = String(code || '').trim().toUpperCase();
  if (!raw || raw === 'EU' || raw === 'UK') {
    return raw === 'UK' ? 'United Kingdom' : '';
  }
  return NAME_BY_CODE[raw] || '';
}

/** Select option text: 🇭🇺 Hungary */
export function shipFromCountryOptionLabel(code) {
  const raw = String(code || '').trim().toUpperCase();
  if (!raw) return '';
  const emoji = countryFlagEmoji(raw);
  const name = shipFromCountryName(raw) || raw;
  return emoji ? `${emoji} ${name}` : name;
}
