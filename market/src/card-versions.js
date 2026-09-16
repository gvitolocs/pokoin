import { namesEqual } from './exact-name.js';
import { printingIdentity } from './identity.js';
import { tilePricePkn } from './pkn.js';
import { TCG_ERA_ORDER, tcgEra, tcgEraId } from './set-logos.js';

const LANG = { japanese: 'JP', western: 'EN', chinese: 'CN', korean: 'KO' };

export function printLangBadge(row) {
  return LANG[String(row?.nationality || '').trim().toLowerCase()] || '';
}

export function collectorSplit(number) {
  const text = String(number || '').trim();
  const frac = text.match(/(\d+)\s*\/\s*(\d+)/);
  if (frac) {
    const n = Number(frac[1]);
    const d = Number(frac[2]);
    return { n, d, secret: d > 0 && n > d };
  }
  const lone = text.match(/(\d+)/);
  if (!lone) {
    return null;
  }
  return { n: Number(lone[1]), d: null, secret: false };
}

function setKey(row) {
  return String(printingIdentity(row).set || '').trim().toLowerCase();
}

/** Promo expansions number unique cards, not regular ↔ IR of the same collector. */
export function isPromoExpansion(row = {}) {
  const set = setKey(row);
  return /\bpromos?\b/.test(set) || /\bblack[\s-]?star\b/.test(set);
}

export function isRaritySibling(left, right) {
  if (!left || !right) {
    return false;
  }
  if (String(left.id || left.card_id) === String(right.id || right.card_id)) {
    return true;
  }
  if (isPromoExpansion(left) || isPromoExpansion(right)) {
    return false;
  }
  if (!namesEqual(left.name, right.name)) {
    return false;
  }
  if (!setKey(left) || setKey(left) !== setKey(right)) {
    return false;
  }
  const a = printingIdentity(left);
  const b = printingIdentity(right);
  const ca = collectorSplit(a.number);
  const cb = collectorSplit(b.number);
  if (!ca || !cb) {
    return false;
  }
  if (ca.n === cb.n && (a.rarity !== b.rarity || a.number !== b.number)) {
    return true;
  }
  return ca.secret !== cb.secret;
}

export function versionOptionLabel(row) {
  const identity = printingIdentity(row);
  return [identity.rarity, identity.number].filter(Boolean).join(' ')
    || identity.set
    || String(row?.name || row?.id || '');
}

function sortKey(row) {
  const identity = printingIdentity(row);
  const parts = collectorSplit(identity.number);
  return {
    secret: parts?.secret ? 1 : 0,
    n: Number.isFinite(parts?.n) ? parts.n : 99999,
    rarity: identity.rarity,
    id: String(row.id || row.card_id || ''),
  };
}

/** CardTrader shows expansion circles only when the reprint family is short. */
export const DESK_SET_SHORTCUT_MAX = 5;

/**
 * CLIP same-illustration rows for desk shortcuts. Prefer the dedicated
 * version-set fetch; fall back to `marketplace-card-page` `versions` so a
 * 2–5 reprint family (CSDC Dialga) paints circles before the second hop.
 */
export function deskClipCandidates(fetched = [], payloadVersions = []) {
  const source = Array.isArray(fetched) && fetched.length ? fetched : payloadVersions;
  return (source || []).filter((row) => row?.id || row?.card_id);
}

/**
 * One printing per expansion for the desk shortcut row. Pass the CLIP
 * same-illustration group (`marketplace-version-set` printings), not every
 * rarity of the English name. Current set first. A singleton still paints
 * one circle. Empty when there are more than DESK_SET_SHORTCUT_MAX sets
 * (then the desk keeps only “More versions...”).
 */
export function deskSetShortcuts(current, candidates = [], { max = DESK_SET_SHORTCUT_MAX } = {}) {
  if (!current?.id && !current?.card_id) {
    return [];
  }
  const bySet = new Map();
  for (const row of [current, ...candidates]) {
    const key = setKey(row);
    if (!key) {
      continue;
    }
    const prev = bySet.get(key);
    if (!prev) {
      bySet.set(key, row);
      continue;
    }
    if (!isRaritySibling(current, prev) && isRaritySibling(current, row)) {
      bySet.set(key, row);
    }
  }
  const rows = [...bySet.values()];
  if (!rows.length || rows.length > max) {
    return [];
  }
  return rows;
}

/** Rarity lineup + other artwork live on `/versions`. Keep that link next to set circles. */
export function deskShowMoreVersions(current, {
  nameRows = [],
  clipRows = [],
  versionCount = 0,
} = {}) {
  if (rarityVersions(current, nameRows).length > 1) {
    return true;
  }
  const clips = (clipRows || []).filter((row) => row?.id || row?.card_id);
  if (clips.length > 1) {
    return true;
  }
  return Number(versionCount) > 1;
}

export function mergePrintingRows(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const row of list || []) {
      const id = String(row?.id || row?.card_id || '');
      if (!id) {
        continue;
      }
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, row);
        continue;
      }
      const merged = { ...prev, ...row };
      if (tilePricePkn(prev) != null && tilePricePkn(row) == null) {
        merged.price = prev.price;
        merged.lowest_price_pkn = prev.lowest_price_pkn;
        merged.pricePkn = prev.pricePkn;
        merged.cheapestPricePkn = prev.cheapestPricePkn;
      }
      byId.set(id, merged);
    }
  }
  return [...byId.values()];
}

export function rarityStep(rows, currentId, delta) {
  const list = rows || [];
  if (list.length < 2) {
    return null;
  }
  const id = String(currentId || '');
  const index = list.findIndex((row) => String(row.id || row.card_id) === id);
  const at = index < 0 ? 0 : index;
  const next = list[(at + Number(delta || 0) + list.length) % list.length];
  if (!next || String(next.id || next.card_id) === id) {
    return null;
  }
  return next;
}

export function rarityVersions(current, candidates = []) {
  if (!current?.id && !current?.card_id) {
    return [];
  }
  if (isPromoExpansion(current)) {
    return [current];
  }
  const pool = [current, ...candidates];
  const seen = new Set();
  const rows = [];
  const queue = [current];
  while (queue.length) {
    const node = queue.shift();
    const id = String(node?.id || node?.card_id || '');
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    rows.push(node);
    for (const row of pool) {
      const other = String(row?.id || row?.card_id || '');
      if (!other || seen.has(other) || !isRaritySibling(node, row)) {
        continue;
      }
      queue.push(row);
    }
  }
  return rows.sort((left, right) => {
    const a = sortKey(left);
    const b = sortKey(right);
    return a.secret - b.secret
      || a.n - b.n
      || a.rarity.localeCompare(b.rarity)
      || a.id.localeCompare(b.id);
  });
}

function uniqueEras(eras) {
  return [...new Set(eras.filter((era) => era && era !== 'Other'))];
}

/**
 * Mixed-era dumps (League Promos, Prize Pack, theme decks, …) have no block
 * of their own. Same CLIP illustration as a dated set → that set's era.
 * Prefer an exact collector n/d sibling so Ultra Ball 131/132 stays Mega
 * Evolution when the cluster also has Scarlet & Violet reprints.
 */
export function inheritEraFromArtwork(row, peers = []) {
  const own = tcgEra(row);
  if (own !== 'Other') {
    return own;
  }
  const frac = collectorSplit(row?.number || row?.card_number);
  const known = [];
  for (const peer of peers) {
    if (!peer || peer === row) {
      continue;
    }
    const id = String(peer.id || peer.card_id || '');
    const self = String(row?.id || row?.card_id || '');
    if (id && self && id === self) {
      continue;
    }
    const era = tcgEra(peer);
    if (!era || era === 'Other') {
      continue;
    }
    known.push({
      era,
      frac: collectorSplit(peer.number || peer.card_number),
    });
  }
  if (!known.length) {
    return 'Other';
  }
  if (frac && Number.isFinite(frac.n)) {
    if (Number.isFinite(frac.d)) {
      const exact = uniqueEras(known
        .filter((peer) => peer.frac && peer.frac.n === frac.n && peer.frac.d === frac.d)
        .map((peer) => peer.era));
      if (exact.length === 1) {
        return exact[0];
      }
      const sameTotal = uniqueEras(known
        .filter((peer) => peer.frac && peer.frac.d === frac.d)
        .map((peer) => peer.era));
      if (sameTotal.length === 1) {
        return sameTotal[0];
      }
    }
    const sameN = uniqueEras(known
      .filter((peer) => peer.frac && peer.frac.n === frac.n)
      .map((peer) => peer.era));
    if (sameN.length === 1) {
      return sameN[0];
    }
  }
  const eras = uniqueEras(known.map((peer) => peer.era));
  return eras.length === 1 ? eras[0] : 'Other';
}

export function groupPrintingsByEra(rows = [], current) {
  const buckets = new Map();
  const seen = new Set();
  for (const row of rows) {
    const id = String(row?.id || row?.card_id || '');
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const era = inheritEraFromArtwork(row, rows);
    if (!buckets.has(era)) {
      buckets.set(era, []);
    }
    buckets.get(era).push(row);
  }
  const currentEra = inheritEraFromArtwork(current, rows);
  const order = [
    currentEra,
    ...TCG_ERA_ORDER.filter((era) => era !== currentEra),
    ...[...buckets.keys()].filter((era) => era !== currentEra && !TCG_ERA_ORDER.includes(era)),
  ];
  return order
    .filter((era) => (buckets.get(era) || []).length)
    .map((era) => ({
      id: tcgEraId(era),
      label: era,
      rows: buckets.get(era),
    }));
}

export function splitVersionPage({ current, nameRows = [], artRows = [] } = {}) {
  const versions = rarityVersions(current, nameRows);
  const currentId = String(current?.id || current?.card_id || '');
  const others = (artRows || []).filter((row) => {
    const id = String(row?.id || row?.card_id || '');
    if (!id || id === currentId) {
      return false;
    }
    // Same-set regular ↔ IR/FA/SIR belong in Rarity Lineup, not an era grid.
    return !isRaritySibling(current, row);
  });
  if (!others.length) {
    return { versions, eras: [] };
  }
  return { versions, eras: groupPrintingsByEra([current, ...others], current) };
}
