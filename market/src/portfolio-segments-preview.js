/**
 * Preview segment split for `/dashboard?dashPreview`.
 *
 * The live table reads `segments` from `GET /api/marketplace-portfolio-history`
 * (run DG-R001). The fixture layout has no account behind it, so the same row
 * shapes are derived here from the dashboard's own preview history series:
 * deterministic arithmetic, no clock and no randomness, so two renders of the
 * preview paint identical sparklines.
 */

/**
 * The era bands exactly as the server labels them: `pokoin-rust/crates/accounts/src/domain/portfolio_segments.rs`,
 * table `BANDS`. The years are that file's strings, so the preview and the API
 * answer say the same thing and a test reads one against the other.
 */
const ERA_DEFS = [
  { key: 'pokemon:era:vintage', id: 'vintage', label: 'Vintage', years: '1999–2003', share: 0 },
  { key: 'pokemon:era:mid', id: 'mid', label: 'Mid era', years: '2003–2013', share: 0.001 },
  { key: 'pokemon:era:xy', id: 'xy', label: 'XY', years: '2013–2016', share: 0.012 },
  { key: 'pokemon:era:sm', id: 'sm', label: 'Sun & Moon', years: '2017–2019', share: 0.06 },
  { key: 'pokemon:era:swsh', id: 'swsh', label: 'Sword & Shield', years: '2020–2023', share: 0.268 },
  { key: 'pokemon:era:sv', id: 'sv', label: 'Scarlet & Violet', years: '2023–2025', share: 0.36 },
  { key: 'pokemon:era:post-sv', id: 'post-sv', label: 'After Scarlet & Violet', years: '2025–', share: 0.295 },
  { key: 'pokemon:era:other', id: 'other', label: 'Promos and other', years: '', share: 0.004 },
];

/** A fixed per-day wobble, never past ±6 % of an era's own share. */
const WOBBLE = [0.03, -0.05, 0.015, -0.02, 0.06, -0.035, 0.008, -0.06, 0.042, -0.012, 0.025, -0.045];

/** Sealed appears on the 10th card day and holds 4 cards at 9 % of the value. */
const SEALED_FROM_CARD_DAY = 10;
const SEALED_CARDS = 4;
const SEALED_SHARE = 0.09;

/** Riftbound is the unpriced row: a pile with no sale behind it. */
const RIFTBOUND_HELD = 40;

function round2(value) {
  return Math.round(value * 100) / 100;
}

function whole(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function amountOf(day, field) {
  const raw = day?.assets?.[field] ?? day?.[field];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function wobbledWeights(dayIndex) {
  return ERA_DEFS.map((era, index) => {
    if (!(era.share > 0)) return 0;
    const wobble = WOBBLE[(dayIndex * 5 + index * 3) % WOBBLE.length];
    return era.share * (1 + wobble);
  });
}

/** Largest-remainder split of `total` over `weights`, integers that add up. */
function splitWhole(total, weights) {
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (!(total > 0) || !(sum > 0)) return weights.map(() => 0);
  const exact = weights.map((weight) => (total * weight) / sum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((acc, part) => acc + part, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; left > 0 && order.length; i += 1) {
    parts[order[i % order.length].index] += 1;
    left -= 1;
  }
  return parts;
}

/**
 * Below this many cards in the day a band's share is smaller than one card, and
 * the whole-card split rightly drops it; at or above it every band with a share
 * of its own holds at least one card, so a preview row reads as held stock.
 */
const WHOLE_CARDS_FROM = 20;

/** Index with the most cards that can still give one away and keep its own. */
function donorIndex(parts) {
  let best = -1;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] > 1 && (best < 0 || parts[index] > parts[best])) best = index;
  }
  return best;
}

/**
 * The whole-card split, plus the one card each held band is owed once the day is
 * big enough for it. Each card comes back off the largest band, so the counts
 * still add up to the day's.
 */
function splitCards(total, weights, everyBandHeld) {
  const parts = splitWhole(total, weights);
  if (!everyBandHeld) return parts;
  for (let index = 0; index < weights.length; index += 1) {
    if (!(weights[index] > 0) || parts[index] > 0) continue;
    const donor = donorIndex(parts);
    if (donor < 0) return parts;
    parts[donor] -= 1;
    parts[index] += 1;
  }
  return parts;
}

/**
 * The API's rows in the API's order and with the API's own labels: games, the
 * cross-game types, the eight Pokémon era bands, then Pokémon's own Sealed and
 * Graded. A game row carries no label, exactly as `segment_defs` answers.
 */
function previewDefs() {
  const defs = [
    { key: 'game:pokemon', group: 'game', game: 'pokemon' },
    { key: 'game:riftbound', group: 'game', game: 'riftbound' },
    { key: 'all:sealed', group: 'type', game: 'all', label: 'Sealed' },
    { key: 'all:graded', group: 'type', game: 'all', label: 'Graded' },
  ];
  for (const era of ERA_DEFS) {
    defs.push({ key: era.key, group: 'era', game: 'pokemon', label: era.label, years: era.years });
  }
  defs.push({ key: 'pokemon:sealed', group: 'type', game: 'pokemon', label: 'Sealed' });
  defs.push({ key: 'pokemon:graded', group: 'type', game: 'pokemon', label: 'Graded' });
  return defs;
}

/**
 * Raw answer for one preview history series: every day that carries a card
 * value gets the split, the days before it get none, exactly like a live
 * series that only started recording segments recently.
 */
export function previewSegmentsFrom(series) {
  const rows = Array.isArray(series) ? series : [];
  const days = [];
  let cardDay = 0;
  for (const day of rows) {
    const date = String(day?.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const value = amountOf(day, 'cardsValuePkn');
    if (value == null || !(value > 0)) {
      days.push({ date, cardsValuePkn: value, segments: {} });
      continue;
    }
    cardDay += 1;
    const held = whole(amountOf(day, 'cardsHeld'));
    const priced = whole(amountOf(day, 'cardsPriced'));
    const weights = wobbledWeights(cardDay);
    const weightSum = weights.reduce((acc, weight) => acc + weight, 0);
    const scale = value / weightSum;
    const eraValues = weights.map((weight) => round2(scale * weight));
    // The rounding residual lands on the biggest era, so the eras add up to
    // the day's card value to the cent.
    const residual = round2(value - eraValues.reduce((acc, part) => acc + part, 0));
    const biggest = weights.indexOf(Math.max(...weights));
    eraValues[biggest] = round2(eraValues[biggest] + residual);
    const eraHeld = splitCards(held, weights, held >= WHOLE_CARDS_FROM);
    const eraPriced = splitCards(priced, weights, held >= WHOLE_CARDS_FROM);
    // A slice with no card in it that day is absent, like the API answers, and
    // its share of the value rides on the biggest era that is held.
    const present = eraValues.map((_, index) => eraHeld[index] > 0 && eraValues[index] > 0);
    const folded = eraValues.reduce((acc, part, index) => acc + (present[index] ? 0 : part), 0);
    let sink = biggest;
    if (!present[sink]) sink = present.findIndex((yes) => yes);
    if (folded > 0 && sink >= 0) eraValues[sink] = round2(eraValues[sink] + folded);

    const segments = { 'game:pokemon': [round2(value), priced, held] };
    ERA_DEFS.forEach((era, index) => {
      if (!present[index]) return;
      segments[era.key] = [eraValues[index], eraPriced[index], eraHeld[index]];
    });
    if (cardDay >= SEALED_FROM_CARD_DAY) {
      const sealed = [round2(value * SEALED_SHARE), SEALED_CARDS, SEALED_CARDS];
      segments['pokemon:sealed'] = sealed;
      segments['all:sealed'] = sealed;
    }
    segments['game:riftbound'] = [0, 0, RIFTBOUND_HELD];
    days.push({ date, cardsValuePkn: round2(value), segments });
  }
  return { days, segmentDefs: previewDefs() };
}
