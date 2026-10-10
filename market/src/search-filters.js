import { artistPrintRegion } from './locale.js';
import { printLangBadge } from './card-versions.js';
import { printingIdentity, suggestKind } from './identity.js';
import { pokedexPartnerNumbers, pokedexSortValue } from './pokedex.js';
import { tilePricePkn } from './pkn.js';
import { assignOfficialIndexes, officialListFor } from './set-official-lists.js';
import { expansionSortValue } from './tcg-eras.js';
import { isFeatureAlbumArt } from './art-layout.js';

export function searchRarity(card) {
  return printingIdentity(card).rarity;
}

export function searchSet(card) {
  return printingIdentity(card).set;
}

export function searchPrintLang(card) {
  return printLangBadge(card);
}

export function uniqueSearchOptions(cards, pick) {
  return [...new Set((cards || []).map(pick).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

/** Clone a Tag Team GX leftover once per partner Dex for album Pokédex order. */
export function expandPokedexPairRows(cards) {
  const out = [];
  for (const card of cards || []) {
    const nums = pokedexPartnerNumbers(card);
    if (nums.length < 2) {
      out.push(card);
      continue;
    }
    const id = card.id || card.card_id || '';
    for (const n of nums) {
      out.push({
        ...card,
        pokedexSlot: n,
        albumDupKey: `${id}:${n}`,
      });
    }
  }
  return out;
}

export function albumTileKey(card) {
  return card?.albumDupKey || card?.id || card?.card_id || '';
}

export function filterSearchCards(cards, {
  type = 'all',
  rarity = '',
  set = '',
  sort = 'match',
  query = '',
  print = '',
  expandPokedexPairs = false,
} = {}) {
  const needle = String(query || '').trim().toLowerCase();
  let rows = [...(cards || [])];
  if (print) {
    rows = rows.filter((card) => artistPrintRegion(card.nationality) === print);
  }
  if (needle) {
    rows = rows.filter((card) => expansionBlob(card).includes(needle));
  }
  if (type === 'singles') {
    rows = rows.filter((card) => suggestKind(card) === 'Singles');
  } else if (type === 'sealed') {
    rows = rows.filter((card) => suggestKind(card) !== 'Singles');
  }
  if (rarity) {
    rows = rows.filter((card) => searchRarity(card) === rarity);
  }
  if (set) {
    rows = rows.filter((card) => searchSet(card) === set);
  }
  if (sort === 'price-asc') {
    rows.sort((a, b) => (tilePricePkn(a) || Infinity) - (tilePricePkn(b) || Infinity));
  } else if (sort === 'price-desc') {
    rows.sort((a, b) => (tilePricePkn(b) || 0) - (tilePricePkn(a) || 0));
  } else if (sort === 'name') {
    rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  } else if (sort === 'pokedex') {
    if (expandPokedexPairs) rows = expandPokedexPairRows(rows);
    rows.sort(comparePokedexAlbumSort);
  }
  return rows;
}

/** CLIP `pokoin_version_sets` key. Missing version stays a singleton so reprints do not merge. */
export function artworkVersionKey(card) {
  const version = String(card?.version || card?.version_set || '').trim();
  if (version) return version;
  return `id:${card?.id || card?.card_id || ''}`;
}

/** Artist pile popup order: normal printing, Poké Ball, Master Ball, then the rest. */
export function pileCardTier(card) {
  const identity = printingIdentity(card);
  const blob = `${identity.rarity || ''} ${identity.tileLine || ''} ${card.rarity || ''} ${card.expansion_name || card.expansionName || ''}`
    .toLowerCase()
    .replace(/é/g, 'e');
  if (blob.includes('master ball')) return 2;
  if (blob.includes('poke ball')) return 1;
  return 0;
}

/**
 * A shared version key is one painting. Item and trainer cards with the
 * same name often have different paintings, so they only pile when the
 * artwork match gave them the same key.
 */
export function sharesReprintArtwork(card) {
  return !isLegendCard(card);
}

/**
 * Artist desk: collapse same-artwork printings (shared CLIP version key) into
 * one pile row, in sort order. LEGEND halves keep their own rows — the
 * landscape pair forms the full art side by side. Tag Team Pokédex clones
 * (same card twice) dedupe by card id.
 */
export function groupArtworkRows(cards) {
  const map = new Map();
  for (const card of cards || []) {
    const id = String(card?.id || card?.card_id || '');
    // A full-art painting is never a reprint of the framed card, even when CLIP gave
    // both the same key (trainer items/supporters: same subject, different art).
    const key = sharesReprintArtwork(card)
      ? `${artworkVersionKey(card)}${isFeatureAlbumArt(card) ? ':fa' : ''}`
      : `id:${id}`;
    let group = map.get(key);
    if (!group) {
      group = { key, cards: [], seen: new Set() };
      map.set(key, group);
    }
    if (id && group.seen.has(id)) continue;
    if (id) group.seen.add(id);
    group.cards.push(card);
  }
  return [...map.values()];
}

/** HGSS LEGEND name (not Call of Legends / Shining Legends set titles). */
export function isLegendCard(card) {
  const name = String(card?.name || '').replace(/\s+/g, ' ').trim();
  return /\blegend$/i.test(name);
}

/**
 * Matching LEGEND halves share related CLIP version keys (public card_ids of
 * consecutive leftovers, e.g. v263304 Top + v263306 Bottom). Collapse the pair
 * so WCD / JP reprints that reuse a half's key cannot sort between them.
 */
export function legendVersionPairKey(card) {
  const key = artworkVersionKey(card);
  const match = /^v(\d+)$/i.exec(key);
  if (!match) return key;
  const n = Number(match[1]);
  return `v${4 * Math.floor(n / 4)}`;
}

/** Top half before Bottom. WCD / Ultra Rare without Top|Bottom follow version parity. */
export function legendHalfOrder(card) {
  const identity = printingIdentity(card);
  const blob = `${identity.rarity || ''} ${identity.number || ''} ${card?.number || ''}`.toLowerCase();
  if (/\btop\b/.test(blob)) return 0;
  if (/\bbottom\b/.test(blob)) return 1;
  const key = artworkVersionKey(card);
  const match = /^v(\d+)$/i.exec(key);
  if (match) {
    const n = Number(match[1]);
    return n === 4 * Math.floor(n / 4) ? 0 : 1;
  }
  return 2;
}

export function albumSortParts(card) {
  return {
    pokedexNum: pokedexSortValue(card),
    expansionSort: expansionSortValue(card),
    collectorSort: collectorSortValue(card),
  };
}

/** Packed species + CLIP cluster-oldest expansion. Pipeline stores this on candidates. */
export function packPokedexSort(pokedexNum, clusterOldest) {
  const dex = Math.max(0, Number(pokedexNum) || 0);
  const cluster = Math.max(0, Number(clusterOldest) || 0);
  return dex * 1_000_000 + cluster;
}

export function compareStoredPokedexSort(a, b) {
  const as = Number(a?.pokedexSort || 0);
  const bs = Number(b?.pokedexSort || 0);
  if (!(as > 0 && bs > 0)) return 0;
  return as - bs
    || artworkVersionKey(a).localeCompare(artworkVersionKey(b))
    || (Number(a.expansionSort) || 0) - (Number(b.expansionSort) || 0)
    || (Number(a.collectorSort) || 0) - (Number(b.collectorSort) || 0)
    || String(a.number || '').localeCompare(String(b.number || ''))
    || String(a.name || '').localeCompare(String(b.name || ''))
    || String(a.id || a.card_id || '').localeCompare(String(b.id || b.card_id || ''));
}

function compareLegendPairTiebreak(a, b) {
  // Pair key, then expansion (Unleashed before WCD), then Top before Bottom
  // within that printing — so a WCD half that reuses the Top version key
  // cannot sort between the set's Top and Bottom.
  return legendVersionPairKey(a).localeCompare(legendVersionPairKey(b))
    || (Number(a.expansionSort) || 0) - (Number(b.expansionSort) || 0)
    || expansionSortValue(a) - expansionSortValue(b)
    || legendHalfOrder(a) - legendHalfOrder(b)
    || (Number(a.collectorSort) || 0) - (Number(b.collectorSort) || 0)
    || collectorSortValue(a) - collectorSortValue(b)
    || String(a.number || '').localeCompare(String(b.number || ''))
    || String(a.name || '').localeCompare(String(b.name || ''))
    || String(a.id || a.card_id || '').localeCompare(String(b.id || b.card_id || ''));
}

function comparePokedexAlbumSort(a, b) {
  const aDex = pokedexSortValue(a);
  const bDex = pokedexSortValue(b);
  // Live species (or pokedexSlot on a Tag Team clone) first. Stored
  // pokedex_sort can still pack first-name Dex; CLIP cluster-oldest stays
  // the packed remainder. Items already rank TRAINER_DEX live.
  if (aDex !== bDex) return aDex - bDex;
  const aLegend = isLegendCard(a);
  const bLegend = isLegendCard(b);
  const aStored = Number(a?.pokedexSort || 0);
  const bStored = Number(b?.pokedexSort || 0);
  if (aStored > 0 && bStored > 0) {
    const aCluster = aStored % 1_000_000;
    const bCluster = bStored % 1_000_000;
    if (aCluster !== bCluster) return aCluster - bCluster;
    // LEGEND Top/Bottom (and WCD/JP halves that share related version keys)
    // stay adjacent so the album grid forms the full landscape art.
    if (aLegend && bLegend) {
      return compareLegendPairTiebreak(a, b);
    }
    return artworkVersionKey(a).localeCompare(artworkVersionKey(b))
      || (Number(a.expansionSort) || 0) - (Number(b.expansionSort) || 0)
      || (Number(a.collectorSort) || 0) - (Number(b.collectorSort) || 0)
      || String(a.number || '').localeCompare(String(b.number || ''))
      || String(a.name || '').localeCompare(String(b.name || ''))
      || String(a.id || a.card_id || '').localeCompare(String(b.id || b.card_id || ''));
  }
  if (aLegend && bLegend) {
    return compareLegendPairTiebreak(a, b);
  }
  return expansionSortValue(a) - expansionSortValue(b)
    || collectorSortValue(a) - collectorSortValue(b)
    || String(a.number || '').localeCompare(String(b.number || ''))
    || String(a.name || '').localeCompare(String(b.name || ''))
    || String(a.id || a.card_id || '').localeCompare(String(b.id || b.card_id || ''));
}

export function collectorSortValue(card) {
  const number = String(printingIdentity(card).number || '').trim();
  const frac = number.match(/^([A-Za-z]*)(\d+)\s*\/\s*([A-Za-z]*)(\d+)/i);
  if (frac) {
    const prefix = frac[1].toUpperCase();
    const n = Number(frac[2]);
    if (prefix) {
      return 100000 + collectorPrefixRank(prefix) * 1000 + n;
    }
    return n;
  }
  const letter = number.match(/^([A-Za-z]{1,5})\s*(\d{1,4})[A-Za-z]?$/i);
  if (letter) {
    return 100000 + collectorPrefixRank(letter[1]) * 1000 + Number(letter[2]);
  }
  const match = number.match(/(\d+)/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function collectorPrefixRank(prefix) {
  const key = String(prefix || '').toUpperCase();
  const order = ['AR', 'SH', 'TG', 'GG', 'SVP', 'SWSH', 'SM'];
  const at = order.indexOf(key);
  return at >= 0 ? at + 1 : 50;
}

function expansionBlob(card) {
  const identity = printingIdentity(card);
  return `${card.name || ''} ${card.localized_name || ''} ${identity.number} ${identity.rarity} ${identity.set}`.toLowerCase();
}

const NOT_SET_SINGLE = /\b(jumbo|oversized|gold metal|mug|glass|tumbler|playmat|plush|figure|keychain|sticker sheet)\b/i;
const SEALED_SET_PRODUCT = /\bpok(?:e|é)mon tcg:\s*holiday calendar(?:\s+20\d{2})?\b/i;
const MERCH_NAME = /\b(backpack|hoodie|t-?shirts?)\b/i;
const SET_ACCESSORY = /\b(boxes|box|frames?|markers?|storage|tins?|display frame|condition marker|premium deck set)\b/i;
const COLLECTOR_FRACTION = /\d{1,4}[a-z]?\s*\/\s*\d{1,4}/i;

function hasPrintedCollectorNumber(card) {
  return COLLECTOR_FRACTION.test(printingIdentity(card).number || '');
}

/** Set desk / home tiles: TCG singles. Drop merch, jumbos, and metal replicas. */
export function isSetDeskCard(card) {
  if (suggestKind(card) !== 'Singles') {
    return false;
  }
  if (NOT_SET_SINGLE.test(expansionBlob(card))) {
    return false;
  }
  // CardTrader currently labels the sealed annual calendars as cards inside
  // the Holiday Calendar expansion. Keep the set desk limited to pack cards.
  if (SEALED_SET_PRODUCT.test(String(card.name || ''))) {
    return false;
  }
  // IC backpacks use a region as the "number". Nemona's Backpack 083/091 is a card.
  if (MERCH_NAME.test(String(card.name || '')) && !hasPrintedCollectorNumber(card)) {
    return false;
  }
  // Client net while ingest kind catches up. Prefer CardTrader category_id
  // (and Qwen leftover kind) on marketplace_cards. Keep Energy. Secret Box
  // with a printed n/m stays.
  const accessoryBlob = `${card.name || ''} ${printingIdentity(card).number || ''}`;
  if (SET_ACCESSORY.test(accessoryBlob) && !hasPrintedCollectorNumber(card)) {
    return false;
  }
  return true;
}

function cardId(card) {
  return String(card?.id || card?.card_id || '');
}

export function cardIsReverse(card) {
  return /\breverse\b/.test(expansionBlob(card));
}

export function cardIsFirstEdition(card) {
  return /\b(?:1st|first)\s*ed/.test(expansionBlob(card));
}

export function filterExpansionCards(cards, {
  query = '',
  sort = 'number',
  rarity = '',
  language = '',
  fallbackLang = '',
  reverse = 'any',
  firstEdition = 'any',
  listed = 'any',
  expansionSlug = '',
  expansionName = '',
} = {}) {
  const needle = String(query || '').trim().toLowerCase();
  let rows = (cards || []).filter(isSetDeskCard);
  if (needle) {
    rows = rows.filter((card) => expansionBlob(card).includes(needle));
  }
  if (rarity) {
    rows = rows.filter((card) => searchRarity(card) === rarity);
  }
  if (language) {
    rows = rows.filter((card) => (searchPrintLang(card) || fallbackLang) === language);
  }
  if (reverse === 'yes') {
    rows = rows.filter((card) => cardIsReverse(card));
  } else if (reverse === 'no') {
    rows = rows.filter((card) => !cardIsReverse(card));
  }
  if (firstEdition === 'yes') {
    rows = rows.filter((card) => cardIsFirstEdition(card));
  } else if (firstEdition === 'no') {
    rows = rows.filter((card) => !cardIsFirstEdition(card));
  }
  if (listed === 'yes') {
    rows = rows.filter((card) => (tilePricePkn(card) || 0) > 0 || card.isMarketAvailable || card.inStock);
  } else if (listed === 'no') {
    rows = rows.filter((card) => !((tilePricePkn(card) || 0) > 0 || card.isMarketAvailable || card.inStock));
  }
  if (sort === 'price-asc') {
    rows.sort((a, b) => (tilePricePkn(a) || Infinity) - (tilePricePkn(b) || Infinity));
  } else if (sort === 'price-desc') {
    rows.sort((a, b) => (tilePricePkn(b) || 0) - (tilePricePkn(a) || 0));
  } else if (sort === 'name') {
    rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))
      || collectorSortValue(a) - collectorSortValue(b));
  } else if (sort === 'official') {
    const list = officialListFor(expansionSlug, expansionName);
    const indexes = assignOfficialIndexes(rows, list);
    rows = rows.filter((card) => indexes.has(cardId(card)));
    rows.sort((a, b) => {
      const ia = indexes.get(cardId(a));
      const ib = indexes.get(cardId(b));
      return ia - ib
        || collectorSortValue(a) - collectorSortValue(b)
        || String(a.name || '').localeCompare(String(b.name || ''));
    });
  } else {
    rows.sort(compareSetDeskNumber);
  }
  return rows;
}

/** Stored position inside the expansion (`set_order`, scripts/sql/113_set_order.sql); 0 = not ranked yet. */
export function setOrderValue(card) {
  const n = Number(card?.setOrder ?? card?.set_order);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Set desk "Number" order: the stored set position, the same order as the
 * card-desk ‹ › arrows, so every game's numbering (Magic tokens, Weiss
 * BD/W03-001, One Piece OP14-039a) sorts like the server. Rows the build-lists
 * job has not ranked yet go after the ranked ones (as the arrows do) and keep
 * the collector-number comparator among themselves.
 */
export function compareSetDeskNumber(a, b) {
  const ao = setOrderValue(a);
  const bo = setOrderValue(b);
  if (ao > 0 || bo > 0) {
    if (!(ao > 0)) return 1;
    if (!(bo > 0)) return -1;
    if (ao !== bo) return ao - bo;
  } else {
    const byNumber = collectorSortValue(a) - collectorSortValue(b);
    if (byNumber) return byNumber;
  }
  return String(a.name || '').localeCompare(String(b.name || ''));
}
