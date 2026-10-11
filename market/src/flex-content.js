// /flex page content and small view rules shared by the React and Solid pages.

/** Fallback until GET /api/pokoin-partner?action=directory is live with real shops. */
export const FLEX_PLACEHOLDER_STORES = [
  { id: 'milan-ace', name: 'Ace Hobby', city: 'Milan', country: 'Italy', role: 'drop-off + pick-up' },
  { id: 'berlin-deck', name: 'Deck & Dice', city: 'Berlin', country: 'Germany', role: 'drop-off + pick-up' },
  { id: 'lisbon-cardforge', name: 'Cardforge', city: 'Lisbon', country: 'Portugal', role: 'drop-off + pick-up' },
  { id: 'copenhagen-tabletop', name: 'Tabletop North', city: 'Copenhagen', country: 'Denmark', role: 'pick-up' },
];

export const FLEX_STEPS = [
  { art: 'step-pack', title: 'Pack it yourself', text: 'Cards go in a Flex box — a sturdy shell, padded inside — instead of a random mailer.' },
  { art: 'step-drop', title: 'Drop at a partner', text: 'A partner shop scans your pack. It does not repack anything, it only loads it.' },
  { art: 'step-bag', title: 'One shared bag', text: 'Your pack rides with everyone else’s in one ~20 kg Pokoin bag to the sorting center.' },
  { art: 'step-collect', title: 'Collect with a code', text: 'The buyer picks it up at a partner shop with a QR code, or it continues home.' },
];

export const FLEX_TABLE_SIZES = [4, 20, 50];

/** Tracked and untracked choices for "Ship alone with", cheapest first. */
export function flexServiceChoices(services) {
  return [true, false]
    .map((wantTracked) => (services || []).find((row) => row.tracked === wantTracked))
    .filter(Boolean)
    .sort((a, b) => a.cents - b.cents);
}

/** Live partner directory, or null to keep the placeholders. */
export function fetchFlexStores() {
  return fetch('/api/pokoin-partner?action=directory')
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => (Array.isArray(body?.stores) && body.stores.length ? body.stores : null))
    .catch(() => null);
}
