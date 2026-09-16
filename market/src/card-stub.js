import { rewriteCatalogLang } from './locale.js';
import { PROVISIONAL_PUBLIC_OFFSET, leftoverCdnId, realPublicCardId } from './card-id.js';

export { PROVISIONAL_PUBLIC_OFFSET, leftoverCdnId, realPublicCardId };

/** First paint for a card desk from the URL. Do not wait on marketplace-card-page. */

export function provisionalPublicCardId(cardId) {
  const real = realPublicCardId(cardId);
  if (!/^\d+$/.test(real)) {
    return real;
  }
  return String(Number(real) + PROVISIONAL_PUBLIC_OFFSET);
}

/** Query both leftover × 2 and the old 999 stamp so stale tile rows still hit. */
export function expandProvisionalCardIds(ids, max = 48) {
  const seen = new Set();
  const out = [];
  for (const raw of ids || []) {
    const real = realPublicCardId(String(raw || '').trim());
    if (!/^\d+$/.test(real)) {
      continue;
    }
    for (const id of [real, provisionalPublicCardId(real)]) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      out.push(id);
      if (out.length >= max) {
        return out;
      }
    }
  }
  return out;
}

export function normalizeRecentCardIds(ids, max = 24) {
  const seen = new Set();
  const out = [];
  for (const raw of ids || []) {
    const id = realPublicCardId(String(raw || '').trim());
    if (!/^\d+$/.test(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

export function rewriteCanonicalCardPath(path, cardId, lang = 'en') {
  const id = realPublicCardId(cardId);
  const raw = String(path || '').trim();
  const code = String(lang || 'en').toLowerCase();
  let next = raw;
  if (/^\d+$/.test(id)) {
    if (/\/cards\/\d+/.test(raw)) {
      next = raw.replace(/\/cards\/\d+/, `/cards/${id}`);
    } else if (!raw) {
      next = `/marketplace/${code}/cards/${id}`;
    }
  }
  return rewriteCatalogLang(next, code);
}

const RARITY_TAILS = [
  'special-illustration-rare',
  'illustration-rare',
  'gold-secret-rare',
  'secret-rare',
  'hyper-rare',
  'ultra-rare',
  'double-rare',
  'rainbow-rare',
  'gold-rare',
  'amazing-rare',
  'full-art',
  'alt-art',
  'cracked-ice-holo',
  'cosmos-holo',
  'reverse-holo',
  'holo-rare',
  'non-holo',
];

function prettySlug(slug) {
  const words = String(slug || '').split('-').filter(Boolean);
  const out = [];
  for (const word of words) {
    if (word === 's' && out.length) {
      out[out.length - 1] += "'s";
      continue;
    }
    if (word === 'ex') {
      out.push('ex');
      continue;
    }
    out.push(word.charAt(0).toUpperCase() + word.slice(1));
  }
  return out.join(' ');
}

/** SV / SM / XY prefixes in the set tail of a promo slug. */
function prettySetSlug(slug) {
  return prettySlug(slug).replace(/^(Sv|Sm|Xy|Bw|Dp|Hg|Sw|Ssp|Mep) /, (_, code) => `${code.toUpperCase()} `);
}

export function leftoverUrl(cardId, nameSlug) {
  const leftover = leftoverCdnId(cardId);
  if (!leftover) {
    return '';
  }
  const stem = String(nameSlug || '').replace(/^-+|-+$/g, '');
  return `/card-images/${leftover}_${stem}.jpg`;
}

/** Leftover JPEG key (`ct_id`, public / 2). Used when the BFF only has a CardTrader preview_ (tiles drop those). */
export function leftoverUrlFromCard(card = {}) {
  const id = String(card.id || card.card_id || '');
  if (!/^\d+$/.test(id)) {
    return '';
  }
  const path = String(card.canonicalPath || card.canonical_path || '');
  const slugPart = path.split('/').filter(Boolean).pop() || '';
  const fromPath = parseMarketplaceCardSlug(slugPart).nameSlug;
  if (fromPath && !/^\d+$/.test(fromPath)) {
    return leftoverUrl(id, fromPath);
  }
  const fromName = String(card.name || '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return leftoverUrl(id, fromName);
}

function stripTrailingSetCode(nameSlug) {
  return String(nameSlug || '').replace(/-[a-z]{1,4}\d[a-z0-9]{0,4}$/i, '');
}

function takeYearVersion(nameSlug) {
  const raw = String(nameSlug || '');
  const match = raw.match(/^(.*?)-((?:[a-z]+-)+[a-z]+-\d{4})$/i);
  if (!match || !match[1]) {
    return { nameSlug: raw, version: '' };
  }
  return { nameSlug: match[1], version: prettySlug(match[2]) };
}

function lastPromoCollector(body) {
  const matches = [...String(body || '').matchAll(/-([a-z]{2,8}p)-(\d{1,4})(?:-|$)/gi)];
  return matches[matches.length - 1] || null;
}

export function preferCatalogName(next, prev) {
  const a = String(next || '').trim();
  const b = String(prev || '').trim();
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al.startsWith(`${bl} `) || al.startsWith(`${bl}-`)) return b;
  if (bl.startsWith(`${al} `) || bl.startsWith(`${al}-`)) return a;
  return a;
}

export function preferCatalogNumber(next, prev) {
  const a = String(next || '').trim();
  const b = String(prev || '').trim();
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  if (a.includes('|') && !b.includes('|')) return a;
  if (b.includes('|') && !a.includes('|')) return b;
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;
  return a;
}

export function mergeDeskCard(base, overlay) {
  if (!overlay) return base || null;
  if (!base) return overlay;
  return {
    ...base,
    ...overlay,
    name: preferCatalogName(overlay.name, base.name),
    set: overlay.set || overlay.set_name || base.set || base.set_name || '',
    set_name: overlay.set_name || overlay.set || base.set_name || base.set || '',
    number: preferCatalogNumber(overlay.number || overlay.card_number, base.number || base.card_number),
    rarity: overlay.rarity || base.rarity || '',
    emoji: overlay.emoji || overlay.cardIdentityEmoji || base.emoji || base.cardIdentityEmoji || '',
    cardIdentityEmoji: overlay.cardIdentityEmoji || overlay.emoji || base.cardIdentityEmoji || base.emoji || '',
    artist: overlay.artist || overlay.illustrator || base.artist || base.illustrator || '',
    illustrator: overlay.illustrator || overlay.artist || base.illustrator || base.artist || '',
    version: overlay.version || base.version || '',
  };
}

export function parseMarketplaceCardSlug(slug) {
  const raw = String(slug || '').trim().replace(/^\/+|\/+$/g, '');
  const body = raw.replace(/^(card|product)-/i, '');
  if (!body) {
    return { name: '', nameSlug: '', rarity: '', number: '', set: '' };
  }
  const numMatch = body.match(/-(\d{1,3})-(\d{2,3})(?:-|$)/);
  let number = '';
  let set = '';
  let head = body;
  let promoVersion = '';
  if (numMatch) {
    number = `${numMatch[1]}/${numMatch[2]}`;
    set = prettySetSlug(body.slice(numMatch.index + numMatch[0].length).replace(/^-/, ''));
    head = body.slice(0, numMatch.index);
  } else {
    const promoMatch = lastPromoCollector(body);
    if (promoMatch) {
      number = `${promoMatch[1].toUpperCase()} ${promoMatch[2]}`;
      set = prettySetSlug(body.slice(promoMatch.index + promoMatch[0].length).replace(/^-/, ''));
      const peeled = takeYearVersion(body.slice(0, promoMatch.index));
      head = peeled.nameSlug;
      promoVersion = peeled.version;
    } else {
      const emptyCollector = body.indexOf('--');
      if (emptyCollector > 0) {
        head = body.slice(0, emptyCollector);
        set = prettySetSlug(body.slice(emptyCollector + 2));
      }
    }
  }
  let rarity = '';
  let nameSlug = head;
  for (const token of RARITY_TAILS) {
    if (head === token || head.endsWith(`-${token}`)) {
      rarity = prettySlug(token);
      nameSlug = head.slice(0, Math.max(0, head.length - token.length)).replace(/-$/, '');
      break;
    }
    if (head.startsWith(`${token}-`)) {
      rarity = prettySlug(token);
      nameSlug = head.slice(token.length + 1);
      break;
    }
  }
  if (!rarity && promoVersion) {
    rarity = promoVersion;
  }
  if (rarity) {
    nameSlug = stripTrailingSetCode(nameSlug);
  }
  return {
    name: prettySlug(nameSlug),
    nameSlug,
    rarity,
    number,
    set,
  };
}

export function cardStubFromRoute({ cardId, lang = 'en', slug = '' } = {}) {
  const id = String(cardId || '');
  if (!/^\d+$/.test(id)) {
    return null;
  }
  const parsed = parseMarketplaceCardSlug(slug);
  const language = String(lang || 'en').toLowerCase() || 'en';
  const canonicalPath = slug
    ? `/marketplace/${language}/cards/${id}/${slug}`
    : `/marketplace/${language}/cards/${id}`;
  const leftover = leftoverUrl(id, parsed.nameSlug);
  const homepage = leftover ? leftover.replace(/\.jpg$/i, '_homepage.webp') : '';
  const number = parsed.rarity && parsed.number
    ? `${parsed.rarity} | ${parsed.number}`
    : parsed.number;
  return {
    id,
    card_id: id,
    name: parsed.name,
    set: parsed.set,
    set_name: parsed.set,
    number,
    rarity: parsed.rarity || '',
    productType: 'card',
    itemKind: 'single',
    canonicalPath,
    canonical_path: canonicalPath,
    imageUrl: leftover,
    gridImageUrl: leftover,
    heroImageUrl: leftover,
    homepageImageUrl: homepage,
    tileImageUrl: homepage,
  };
}
