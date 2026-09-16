/** Pull `Illus.` names out of western leftover PP-OCRv5 text. */

const ILLUS_RE = /(?:\b(?:illu|mllus|illus|ithus|ilus|ilius|wus|fles|llus)(?:\.\s*|\s+))([A-Za-z0-9\u00C0-\u024F][A-Za-z0-9\u00C0-\u024F .,'/&-]{0,80})/i;

const HANDLE_JUNK = new Set([
  'hp', 'gx', 'ex', 'v', 'ar', 'rr', 'ur', 'sar', 'sir', 'fig', 'tag', 'break',
  'vmax', 'vstar', 'm6a', 'wrr', 'holo',
]);

function foldDiacritics(value) {
  return String(value || '').normalize('NFD').replace(/\p{M}+/gu, '');
}

const CUT_RE = /\s+(?:during your turn|you may play|weakness|retreat|when your|pokémon-|pokemon-|while\b|it['’]s\b|this attack\b|once during\b|©|NO\.|HT:|WT:|\bWh\b|\bRes\b|\d{1,3}[a-z]?\/\d{2,4})\b/i;

const STUDIO_FIX = [
  [/^sban graphics(?:\s+(?:pok|vrule|v rule))?$/i, '5ban Graphics'],
  [/^5ban graphics(?:\s+(?:pok|vrule|v rule))?$/i, '5ban Graphics'],
  [/^planeta(?:\s+vrule)?$/i, 'PLANETA'],
];

const JUNK = new Set([
  'your', 'turn', 'match', 'the', 'and', 'graphics', 'rule', 'illus',
]);

const STOP = new Set([
  ...JUNK,
  'a', 'an', 'as', 'around', 'another', 'became', 'because', 'can', 'comes',
  'creatures', 'defense', 'discard', 'doesn', 'during', 'eat', 'from', 'gamefreak',
  'if', 'into', 'it', 'its', 'may', 'need', 'nintendo', 'of', 'once', 'play',
  'pok', 'pokemon', 'result', 'retreat', 'stadium', 'study', 'that', 'then',
  'this', 'vrule', 'weakness', 'what', 'when', 'while', 'with', 'you',
  'evolves', 'restored', 'apparently', 'swinging', 'recordings', 'therefore',
]);

const ENGLISH = new Set([
  'attention', 'away', 'back', 'becomes', 'bigger', 'blink', 'body', 'blown',
  'ceilings', 'chase', 'chomps', 'choose', 'claws', 'colors', 'comes', 'contraction',
  'done', 'down', 'downpours', 'eating', 'eats', 'elegant', 'enemies', 'even',
  'fall', 'flame', 'force', 'gathers', 'given', 'glow', 'head', 'however',
  'inside', 'itself', 'knocked', 'lightning', 'liquid', 'loathed', 'makes',
  'many', 'membrane', 'metal', 'more', 'mountains', 'moves', 'nearly', 'night',
  'nostrils', 'others', 'out', 'over', 'plants', 'pounds', 'power', 'prey',
  'purchased', 'pupa', 'rank', 'rhythm', 'same', 'sensitive', 'sharp', 'shoulders',
  'snow', 'sound', 'stolen', 'stomach', 'strong', 'tail', 'taller', 'tap',
  'temperature', 'them', 'they', 'tough', 'turns', 'uses', 'using', 'water',
  'without', 'wil', 'glo', 'cla', 'arou', 'basic', 'one', 'for', 'has', 'be',
  'to', 'on', 'in', 'so', 'at', 'by', 'which', 'where', 'making', 'other',
  'search', 'these', 'years', 'causing', 'kicks', 'known', 'fields', 'reach',
  'there', 'like', 'magma', 'move', 'devastating', 'circulates', 'through',
  'degrees', 'fahrenheit', 'places', 'dark', 'starlike', 'silhouette', 'groups',
  'apart', 'fall', 'thickest', 'trees', 'adapt', 'anything', 'avoid', 'between',
  'blasts', 'blends', 'chain', 'ensure', 'exhaled', 'figure', 'flames', 'feelers',
  'fluttering', 'pillows', 'both', 'six', 'some', 'friendly', 'getting',
  'grasslands', 'horns', 'living', 'makeup', 'minerals', 'mornings', 'moving',
  'pathetic', 'powerful', 'remove', 'rocks', 'scent', 'shower', 'since',
  'speed', 'stretch', 'tails', 'touching', 'turning', 'until', 'variety',
  'although', 'earning', 'reverberates', 'nests', 'control', 'strikes',
  'bones', 'forces', 'medium', 'pectoral', 'predicting', 'regardless',
  'dance', 'enemy', 'hairs', 'nothing', 'peaks', 'sneaky', 'tormenting',
  'turned', 'walls', 'watching', 'within', 'about', 'absorbing', 'ancient',
  'angry', 'allies', 'allowing', 'balloons', 'beautiful', 'bloom', 'boosting',
  'bottom', 'brain', 'brass', 'brightly', 'cheeks', 'chasing', 'cloth',
  'competes', 'have', 'split', 'vile', 'sludge', 'volts', 'higher', 'malice',
  'blows', 'cheek', 'chops', 'conquer', 'contains', 'attacks', 'disappears',
  'discharge', 'dopey', 'dreams', 'aside', 'actual', 'continuous', 'draw',
  'people', 'long', 'time', 'after', 'ago', 'thought', 'feared', 'reaper',
  'identifiable', 'eerie', 'howls', 'among', 'hidden', 'quills',
]);

export function cutIllusTail(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.split(CUT_RE)[0].replace(/[.,;:]+$/g, '').trim();
}

export function normalizeArtistName(raw) {
  let name = cutIllusTail(raw);
  name = name.replace(/\d+[a-z]?\/\d+.*$/i, '').trim();
  name = name.replace(/\s+\d+[a-z]?$/i, '').trim();
  name = name.replace(/\s+(?:your\s+)?turn$/i, '').trim();
  if (!/^0\d{3}$/.test(name)) {
    name = name.replace(/\s*c?\d{4}$/i, '').trim();
  }
  name = name.replace(/\s+[A-Za-z]+\d+[A-Za-z0-9]*.*$/g, '').trim();
  name = name.replace(/\s+[A-Za-z]{1,2}\d[A-Za-z0-9]?$/i, '').trim();
  name = name.replace(/\s+v(?:rule|max|star).*$/i, '').trim();
  name = name.replace(/\b(?:nintendo|creatures|game\s*freak)\b.*$/i, '').trim();
  name = name.replace(/\s+/g, ' ');
  for (const [pattern, fixed] of STUDIO_FIX) {
    if (pattern.test(name)) return fixed;
  }
  if (/^planeta\s+[a-z]/i.test(name)) {
    name = name.replace(/^planeta\s+/i, 'PLANETA ');
  }
  return name;
}

export function artistTokens(name) {
  return foldDiacritics(name)
    .replace(/sben|sbon|sban/gi, '5ban')
    .replace(/grophics|grephics/gi, 'graphics')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => (/^5ban$/i.test(token) ? '5ban' : token.replace(/\d+/g, '')))
    .filter((token) => /[A-Za-z]{2,}/.test(token))
    .map((token) => token.toLowerCase());
}

export function artistHeadTokens(name) {
  const tokens = artistTokens(name);
  const head = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const keepYou = token === 'you' && i === 0 && tokens.length >= 2;
    if (STOP.has(token) && !keepYou) {
      if (!head.length) return [];
      break;
    }
    head.push(token);
    if (head.length >= 4) break;
  }
  return head;
}

const FLAVOR_SUFFIX = /(?:ing|ings|ed|edly|ly|tion|tions|ment|ments|ness|ful|ous|less|able|ible|ally|ence|ance)$/;

export function isEnglishFlavorToken(token) {
  const value = String(token || '').toLowerCase();
  if (!value) return true;
  if (ENGLISH.has(value) || STOP.has(value) || JUNK.has(value)) return true;
  if (FLAVOR_SUFFIX.test(value)) return true;
  if (value.length >= 5 && value.endsWith('s') && isEnglishFlavorToken(value.slice(0, -1))) {
    return true;
  }
  return false;
}

export function isEnglishFlavorName(name) {
  const value = String(name || '').trim();
  if (/^0\d{3}$/.test(value)) return false;
  const tokens = artistHeadTokens(value);
  if (!tokens.length) return true;
  return tokens.every(isEnglishFlavorToken);
}

function looksLikeCredit(name) {
  const raw = String(name || '').trim();
  if (/^0\d{3}$/.test(raw)) return true;
  if (/^[A-Z]{3,8}$/.test(raw) && HANDLE_JUNK.has(raw.toLowerCase())) return false;
  if (/^[A-Z]{5,8}$/.test(raw)) return false;
  if (/^[GRWLPFDMY] [A-Z]{3,8}$/.test(raw)) return false;
  const tokens = artistHeadTokens(raw);
  if (!tokens.length) {
    return /^[A-Za-z]{3,4}$/.test(raw) && !HANDLE_JUNK.has(raw.toLowerCase());
  }
  if (isEnglishFlavorName(raw)) return false;
  if (tokens.length === 1) {
    const token = tokens[0];
    if (HANDLE_JUNK.has(token) || ENGLISH.has(token) || (STOP.has(token) && token !== 'you')) {
      return false;
    }
    if (token.length < 3) return false;
    if (token.length === 3 && raw !== raw.toUpperCase()) return false;
    if (token.length >= 5 && /^[a-z]{2,5}en$/.test(token) && token !== 'planeta') return false;
    return true;
  }
  if (tokens.length === 2) {
    if (tokens.some((token) => token.length < 3)) return false;
    if (tokens[0] !== 'you' && ENGLISH.has(tokens[0])) return false;
    if (ENGLISH.has(tokens[1])) return false;
    if (isEnglishFlavorToken(tokens[0]) && tokens[0] !== '5ban' && tokens[0] !== 'planeta' && tokens[0] !== 'you') {
      return false;
    }
    return true;
  }
  // OCR glues the next card line onto the credit (SVP174 "Natsuko Shoji ete"
  // from the ete stamp). Keep a 3+ token credit whose first two tokens read
  // as a name and the rest are short fragments.
  if (tokens.length === 3) {
    if (tokens.some((token) => token.length < 3)) return false;
    if (ENGLISH.has(tokens[0]) && tokens[0] !== 'you') return false;
    if (isEnglishFlavorToken(tokens[0]) && tokens[0] !== '5ban' && tokens[0] !== 'planeta') return false;
    // Tail is a short glued fragment (ete stamp: Natsuko Shoji ete), not a
    // sentence tail (hidden among, people long time, After long).
    const tail = tokens[2];
    if (tail.length > 4 || ENGLISH.has(tail) || STOP.has(tail)) return false;
    // First token must be a real given name (Natsuko), not an article/noun
    // phrase (people long time). plausibility via diacritic-folded letters only.
    if (!/^[a-z]{3,10}$/.test(tokens[0])) return false;
    return true;
  }
  return false;
}

export function isPlausibleArtist(name) {
  const value = String(name || '').trim();
  if (value.length < 3 || value.length > 48) return false;
  if (/^0\d{3}$/.test(value)) return true;
  if (!/[A-Za-z]{3,}/.test(value) && !/[A-Za-z]{3,}/.test(foldDiacritics(value))) return false;
  if (JUNK.has(value.toLowerCase()) || HANDLE_JUNK.has(value.toLowerCase())) return false;
  if (/^\d/.test(value) && !/^5ban /i.test(value) && !/^0\d{3}$/.test(value)) return false;
  const head = artistHeadTokens(value);
  if (!head.length) {
    return /^[A-Za-z]{3,4}$/.test(value) && !HANDLE_JUNK.has(value.toLowerCase());
  }
  if (head.length === 1 && (head[0].length < 3 || (STOP.has(head[0]) && head[0] !== 'you'))) return false;
  if (head.length === 1 && head[0].length === 3 && value !== value.toUpperCase()) return false;
  if (/\b(discard|stadium|energy|damage|weakness|retreat|attach|during|supporter|trainer|your turn|comes into|as a result)\b/i.test(value)
    && (head.length < 2 || artistTokens(value).length > 4)) {
    return false;
  }
  if (/\b(during|weakness|retreat|supporter|trainer|your turn)\b/i.test(value) && head.length < 2) {
    return false;
  }
  return true;
}

export function splitArtistCredits(raw) {
  return String(raw || '')
    .split(/\s*(?:\/|&|,|\band\b)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseOcrArtists(text) {
  const blob = String(text || '').replace(/\n/g, ' ');
  const match = blob.match(ILLUS_RE);
  if (!match) return [];
  return splitArtistCredits(match[1]).map(normalizeArtistName).filter(Boolean);
}

export function foldArtistKey(name) {
  return foldDiacritics(name)
    .toLowerCase()
    .replace(/sben|sbon|sban/g, '5ban')
    .replace(/grophics|grephics/g, 'graphics')
    .replace(/[^a-z0-9]+/g, '')
    .replace(/\d+/g, '');
}

export function collectorNumber(num) {
  const text = String(num || '');
  const slash = text.match(/(\d{1,4})[a-z]?\s*\/\s*\d{1,4}/i);
  if (slash) return String(Number(slash[1]));
  const plain = text.match(/^(\d{1,4})[a-z]?$/i);
  return plain ? String(Number(plain[1])) : '';
}

export function cardArtistKey(name, num) {
  const folded = String(name || '')
    .toLowerCase()
    .replace(/\s+lv\.?\s*\d+/g, '')
    .replace(/[^a-z0-9]+/g, '');
  const number = collectorNumber(num);
  return folded && number ? `${folded}#${number}` : '';
}

export function levenshtein(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left === right) return 0;
  const cols = right.length + 1;
  const prev = new Array(cols);
  const cur = new Array(cols);
  for (let j = 0; j < cols; j += 1) prev[j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j < cols; j += 1) prev[j] = cur[j];
  }
  return prev[right.length];
}

function closeArtistKeys(ocrKey, ioKey) {
  if (!ocrKey || !ioKey) return false;
  if (ocrKey === ioKey) return true;
  const dist = levenshtein(ocrKey, ioKey);
  const longest = Math.max(ocrKey.length, ioKey.length);
  if (longest < 5) return dist === 0;
  if (longest < 8) return dist <= 1;
  return dist <= Math.max(2, Math.floor(longest * 0.18));
}

function tokenDistance(left, right) {
  if (left === right) return 0;
  if (left.length >= 4 && right.startsWith(left)) return 0.4;
  if (right.length >= 4 && left.startsWith(right)) return 0.4;
  const dist = levenshtein(left, right);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  if (prefix >= 5 && dist <= 3) return Math.min(dist, 2);
  return dist;
}

function scoreArtistTokens(ocrTokens, ioName) {
  const ioTokens = artistTokens(ioName);
  if (!ocrTokens.length || !ioTokens.length) return Infinity;
  const compared = Math.min(ocrTokens.length, ioTokens.length);
  let dist = 0;
  for (let i = 0; i < compared; i += 1) {
    dist += tokenDistance(ocrTokens[i], ioTokens[i]);
  }
  if (ocrTokens.length < ioTokens.length && !(compared >= 2 && dist <= 1)) {
    dist += (ioTokens.length - ocrTokens.length) * 1.4;
  }
  return dist;
}

function acceptableScore(score, ocrTokens, ioName) {
  const ioTokens = artistTokens(ioName);
  const compared = Math.min(ocrTokens.length, ioTokens.length);
  if (!compared || !Number.isFinite(score)) return false;
  if (ocrTokens.length === 1 && ioTokens.length > 1) {
    const token = ocrTokens[0];
    if (token === '5ban' || token === 'planeta') return score <= 1.5;
    return token.length >= 6 && score <= 1.5;
  }
  if (compared >= 2 && tokenDistance(ocrTokens[0], ioTokens[0]) <= 1) {
    return score <= Math.max(2.2, compared * 1.6);
  }
  return score <= Math.max(1.2, compared * 1.1);
}

function bestArtistMatch(ocrTokens, names) {
  const scored = [];
  for (const name of names) {
    const ioTokens = artistTokens(name);
    if (ocrTokens.length >= 2 && ioTokens.length < 2) continue;
    const score = scoreArtistTokens(ocrTokens, name);
    if (!Number.isFinite(score)) continue;
    scored.push({ name, score, ioTokens });
  }
  scored.sort((a, b) => a.score - b.score || b.ioTokens.length - a.ioTokens.length);

  const ok = scored.filter((row) => acceptableScore(row.score, ocrTokens, row.name));
  if (ok[0]) {
    const tied = ok[1]
      && Math.abs(ok[1].score - ok[0].score) < 0.05
      && foldArtistKey(ok[0].name) !== foldArtistKey(ok[1].name);
    if (!tied) return ok[0].name;
  }

  const close = scored.filter((row) => (
    ocrTokens.length >= 2
    && row.ioTokens.length >= 2
    && row.score <= 5
    && tokenDistance(ocrTokens[0], row.ioTokens[0]) <= 2
  ));
  if (
    close[0]
    && (!close[1] || close[1].score - close[0].score >= 1)
  ) {
    return close[0].name;
  }

  const first = ocrTokens[0];
  if (first && first.length >= 5) {
    const hits = [];
    const seen = new Set();
    for (const name of names) {
      const tokens = artistTokens(name);
      if (tokens[0] !== first && foldArtistKey(name) !== first) continue;
      const key = foldArtistKey(name);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(name);
    }
    if (hits.length === 1) return hits[0];
  }
  return '';
}

function uniqueArtistNames(names) {
  const seen = new Set();
  const out = [];
  for (const name of names) {
    const key = foldArtistKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function cleanedOcrLabel(raw) {
  const cleaned = normalizeArtistName(raw);
  const source = cleaned || String(raw || '').trim();
  const head = artistHeadTokens(source);
  if (!head.length) return '';
  const original = artistTokens(source);
  const kept = original.slice(0, head.length);
  if (!kept.length) return '';
  return source
    .split(/[^A-Za-z0-9\u00C0-\u024F]+/)
    .filter((token) => /[A-Za-z\u00C0-\u024F]{2,}/.test(/^5ban$/i.test(token) ? token : token.replace(/\d+/g, '')))
    .slice(0, head.length)
    .join(' ')
    .trim();
}

export function matchOcrArtist(ocrName, ioNames = [], cardArtists = []) {
  const raw = String(ocrName || '').trim();
  if (!raw) return '';
  const cleaned = normalizeArtistName(raw) || raw;
  const head = artistHeadTokens(cleaned);
  const cards = uniqueArtistNames(cardArtists);
  const pool = uniqueArtistNames([...cardArtists, ...ioNames]);
  const cleanedFold = foldArtistKey(cleaned);
  if (cleanedFold) {
    const cardExact = cards.find((name) => foldArtistKey(name) === cleanedFold);
    if (cardExact) return cardExact;
  }

  if (/nintend|creat(?:ue|ur|ures)|game\s*freak/i.test(cleaned)) return '';
  if (head.length) {
    const cardHit = bestArtistMatch(head, cards);
    if (cardHit) return cardHit;
    if (isEnglishFlavorName(cleaned)) return '';
    const ioHit = bestArtistMatch(head, pool);
    if (ioHit) return ioHit;

    const headKey = head.join('');
    const close = pool.find((name) => closeArtistKeys(headKey, foldArtistKey(name)));
    if (close) return close;
    const prefix = pool.filter((name) => {
      const key = foldArtistKey(name);
      return key.length >= 8 && (headKey.startsWith(key) || key.startsWith(headKey));
    });
    const prefixFolds = new Set(prefix.map((name) => foldArtistKey(name)));
    if (prefixFolds.size === 1) return prefix[0];
  }

  const label = cleanedOcrLabel(cleaned);
  if (isPlausibleArtist(label) && looksLikeCredit(label) && !isEnglishFlavorName(label)) {
    return label;
  }
  if (isPlausibleArtist(cleaned) && looksLikeCredit(cleaned) && !isEnglishFlavorName(cleaned)) {
    return cleaned;
  }
  return '';
}

export function rowsFromArtistSummaries(payload) {
  return (payload?.artists || payload?.summaries || [])
    .map((row) => ({
      slug: String(row.slug || row.artistSlug || '').trim(),
      name: String(row.name || row.artist || row.illustrator || '').trim(),
      count: Number(row.cardCount || row.count || 0),
    }))
    .filter((row) => row.slug && row.name)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function slugArtist(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function ioArtistsForCard(row, io) {
  if (!io?.byCard) return [];
  const key = cardArtistKey(row.name, row.num);
  if (!key) return [];
  const found = io.byCard.get(key);
  return found ? [...found] : [];
}

export function artistIndexFromOcrRows(rows, { examples = 3, io = null } = {}) {
  const byId = new Map();
  for (const row of rows) {
    const ctId = Number(row.ct_id);
    if (!Number.isFinite(ctId)) continue;
    const prev = byId.get(ctId);
    const text = String(row.text || '');
    if (
      !prev
      || (row.ok && !prev.ok)
      || text.length > String(prev.text || '').length
    ) {
      byId.set(ctId, row);
    }
  }

  const ioNames = io?.names || [];
  const ioFolds = new Set(ioNames.map(foldArtistKey));
  const pokemon = io?.pokemon || new Set();
  const artists = new Map();
  let withArtist = 0;
  let matchedIo = 0;
  for (const row of byId.values()) {
    const cardArtists = ioArtistsForCard(row, io);
    const extracted = parseOcrArtists(row.text);
    const names = [];
    const seen = new Set();
    for (const raw of extracted) {
      const canonical = matchOcrArtist(raw, ioNames, cardArtists);
      if (!canonical) continue;
      const folded = foldArtistKey(canonical);
      if (pokemon.has(folded) && !ioFolds.has(folded)) continue;
      const key = canonical.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(canonical);
    }
    if (!names.length && !extracted.length && cardArtists.length === 1) {
      names.push(cardArtists[0]);
    }
    if (!names.length) continue;
    withArtist += 1;
    const sample = {
      ct_id: Number(row.ct_id),
      card_id: Number(row.card_id),
      name: row.name || '',
      expansion: row.expansion || '',
      num: row.num || '',
    };
    for (const name of names) {
      const ioHit = ioFolds.has(foldArtistKey(name))
        || cardArtists.some((rowName) => foldArtistKey(rowName) === foldArtistKey(name));
      if (ioHit) matchedIo += 1;
      const key = name.toLowerCase();
      let bucket = artists.get(key);
      if (!bucket) {
        bucket = {
          name,
          slug: slugArtist(name),
          count: 0,
          matched: ioHit,
          cards: [],
        };
        artists.set(key, bucket);
      } else if (ioHit) {
        bucket.matched = true;
      }
      bucket.count += 1;
      if (bucket.cards.length < examples) bucket.cards.push(sample);
    }
  }

  return {
    cards: byId.size,
    withArtist,
    missing: byId.size - withArtist,
    matchedIo,
    artists: [...artists.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}
