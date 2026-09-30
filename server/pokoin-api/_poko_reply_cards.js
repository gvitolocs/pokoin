'use strict';

/**
 * Cards Poko names in a reply → catalog cards attached to the assistant turn,
 * so the chat shows their images the same way a user's attached cards show.
 *
 * Sources, in order:
 *   1. structured cards/cardIds Hermes returns (if it ever does),
 *   2. the hidden `[[cards: …]]` line Poko is asked to end with,
 *   3. names Poko lists as bullets / **bold**.
 * Every candidate must resolve to a real catalog row by id or by exact name
 * (most-traded printing). Nothing is invented; unresolved names are dropped.
 */

const MAX_REPLY_CARDS = 6;
const MARKER_RE = /\[\[\s*cards?\s*:\s*([^\]]*)\]\]/gi;

// Poko is asked to tag the cards it names; the line is stripped before display.
const REPLY_CARDS_DIRECTIVE = [
  'When your reply names specific Pokémon cards, end it with one extra line exactly like',
  '[[cards: Card Name | Card Name]] (at most 6, exact card names or Pokoin cardIds from the tools).',
  'The website hides that line and shows those cards as images. Omit it when you name no card.',
].join(' ');

function cleanText(value, max = 200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function uniq(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** A name worth looking up: short, has letters, not a sentence. */
function plausibleName(raw) {
  const name = cleanText(raw, 80)
    .replace(/^[-*•\d.)\s]+/, '')
    .replace(/[*_`"“”]+/g, '')
    .replace(/[:,.;!?]+$/, '')
    .trim();
  if (name.length < 3 || name.length > 60) return '';
  if (!/[A-Za-zÀ-ÿ]/.test(name)) return '';
  if (name.split(' ').length > 7) return '';
  return name;
}

/** Strip the marker line; return display text plus every mention found. */
function extractReplyCardMentions(reply = '') {
  const text = String(reply || '');
  const marked = [];
  const display = text.replace(MARKER_RE, (_, list) => {
    for (const part of String(list).split(/[|,]/)) marked.push(cleanText(part, 80));
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();

  const listed = [];
  for (const line of display.split('\n')) {
    const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (!bullet) continue;
    // "- Jessie & James (Team Rocket) — le due icone…" → "Jessie & James"
    const head = bullet[1].split(/\s[—–-]\s|\s\(|:\s/)[0];
    listed.push(head);
  }
  // Inline lists: "Vecchia scuola: - Jessie & James (Team Rocket) — …"
  for (const match of display.matchAll(/(?:^|[\s:])[-•]\s+([^—–(\n]{3,60}?)\s+(?:[—–]|\()/g)) listed.push(match[1]);
  for (const match of display.matchAll(/\*\*([^*]{3,60})\*\*/g)) listed.push(match[1]);

  const ids = [];
  const names = [];
  for (const raw of marked) {
    if (/^\d{3,12}$/.test(raw)) ids.push(raw);
    else if (plausibleName(raw)) names.push(plausibleName(raw));
  }
  return {
    text: display,
    ids: uniq(ids),
    // Explicit tags first; list/bold names only fill what is left.
    names: uniq([...names, ...listed.map(plausibleName).filter(Boolean)]),
    tagged: marked.length > 0,
  };
}

function cardRow(row = {}) {
  return {
    cardId: String(row.card_id || ''),
    id: String(row.card_id || ''),
    cardName: String(row.name || ''),
    name: String(row.name || ''),
    setName: String(row.set_name || ''),
    source: 'poko',
  };
}

async function resolveByIds(ids, query) {
  if (!ids.length) return [];
  const result = await query(
    `select s.card_id, s.name, s.set_name
       from marketplace_search_candidates s
      where s.card_id::text = any($1::text[]) and s.item_kind <> 'product'`,
    [ids.slice(0, MAX_REPLY_CARDS)],
  );
  const byId = new Map((result?.rows || []).map((row) => [String(row.card_id), row]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean).map(cardRow);
}

/**
 * Exact (case-insensitive) names only, most-traded printing per name — never
 * a fuzzy guess. One scan for all names (no lower(name) index).
 */
async function resolveByNames(names, query) {
  if (!names.length) return [];
  const wanted = names.map((name) => name.toLowerCase());
  const result = await query(
    `select s.card_id, s.name, s.set_name, s.search_weight
       from marketplace_search_candidates s
      where lower(s.name) = any($1::text[]) and s.item_kind <> 'product'
      order by s.search_weight desc nulls last, s.card_id`,
    [wanted],
  );
  const best = new Map();
  for (const row of result?.rows || []) {
    const key = String(row.name || '').toLowerCase();
    if (!best.has(key)) best.set(key, row);
  }
  return wanted.map((key) => best.get(key)).filter(Boolean).map(cardRow);
}

/**
 * @returns {{ text: string, cards: object[] }} display text (marker removed)
 * and up to six real catalog cards.
 */
async function attachReplyCards(reply, { hermesCards = [], query } = {}) {
  const mentions = extractReplyCardMentions(reply);
  if (typeof query !== 'function') return { text: mentions.text, cards: [] };
  const structuredIds = (Array.isArray(hermesCards) ? hermesCards : [])
    .map((row) => cleanText(typeof row === 'object' ? (row?.cardId || row?.id) : row, 20))
    .filter((id) => /^\d{3,12}$/.test(id));
  const cards = [];
  const seen = new Set();
  const push = (card) => {
    if (!card?.cardId || seen.has(card.cardId) || cards.length >= MAX_REPLY_CARDS) return;
    seen.add(card.cardId);
    cards.push(card);
  };
  try {
    for (const card of await resolveByIds(uniq([...structuredIds, ...mentions.ids]), query)) push(card);
    if (cards.length < MAX_REPLY_CARDS) {
      for (const card of await resolveByNames(mentions.names.slice(0, 12), query)) push(card);
    }
  } catch (error) {
    console.warn('poko reply cards: catalog lookup failed', String(error?.message || error).slice(0, 200));
  }
  return { text: mentions.text, cards };
}

module.exports = {
  MAX_REPLY_CARDS,
  REPLY_CARDS_DIRECTIVE,
  attachReplyCards,
  extractReplyCardMentions,
  plausibleName,
};
