// Scan desk row model: pure functions over server rows so the reducer can be
// tested without React. Spec: docs/SCAN_LISTING_WORKFLOW.md.

export const CONDITIONS = ['NM', 'SP', 'MP', 'PL', 'Poor'];
export const LANGUAGES = ['EN', 'IT', 'FR', 'DE', 'ES', 'JP', 'PT', 'NL', 'PL', 'RU', 'KO', 'ZH', 'ZHT', 'ID', 'TH', 'VI'];
export const FINISHES = [
  { value: 'standard', label: 'Standard' },
  { value: 'holo', label: 'Holo' },
  { value: 'reverse', label: 'Reverse' },
  { value: 'stamped', label: 'Stamped' },
  { value: 'promo', label: 'Promo' },
  { value: 'other', label: 'Other' },
];

/** Common divider capacities for a box stack (BCW-style separators). */
export const STACK_SIZES = Object.freeze([1, 5, 10, 20, 25, 40, 50, 60, 80, 100]);

export const DEFAULTS = Object.freeze({
  game: 'pokemon',
  language: 'EN',
  condition: 'NM',
  foilState: 'standard',
  firstEdition: false,
  signed: false,
  altered: false,
  location: '',
  /** Stack index inside the box (divider section). */
  stack: 1,
  /** Cards per stack. Size 1 = one card per divider; Position is hidden. */
  stackSize: 1,
  /** Position inside the current stack (1..stackSize). */
  startPosition: 1,
  quantity: 1,
  mergeRepeats: true,
});

const PHONE_LOST_MS = 12_000;
const SCANNING_MS = 20_000;

/** Upsert rows by id; a row only replaces one with a lower `seq`. */
export function applyItems(rows, items) {
  let next = rows;
  for (const item of items || []) {
    if (!item || !item.id) continue;
    const current = next[item.id];
    if (current && Number(current.seq) >= Number(item.seq)) continue;
    if (next === rows) next = { ...rows };
    next[item.id] = item;
  }
  return next;
}

/** Queue order: physical scan order (fractional positions for copies). */
export function orderedRows(rows) {
  return Object.values(rows || {}).sort((a, b) => Number(a.position) - Number(b.position));
}

function snapStackSize(snap = {}) {
  return Math.max(1, Math.min(9999, Math.trunc(Number(snap.stackSize)) || 1));
}

function snapStack(snap = {}) {
  return Math.max(1, Math.min(9999, Math.trunc(Number(snap.stack)) || 1));
}

function snapPos(snap = {}) {
  return Math.max(1, Math.min(9999, Math.trunc(Number(snap.startPosition)) || 1));
}

/** Absolute card index → { stack, position } for a fixed stack size. */
export function indexToStackPos(index, stackSize) {
  const size = Math.max(1, Math.trunc(Number(stackSize)) || 1);
  const i = Math.max(1, Math.trunc(Number(index)) || 1);
  if (size === 1) return { stack: i, position: 1 };
  const stack = Math.floor((i - 1) / size) + 1;
  const position = ((i - 1) % size) + 1;
  return { stack, position };
}

/** { stack, position } → absolute index for a fixed stack size. */
export function stackPosToIndex(stack, position, stackSize) {
  const size = Math.max(1, Math.trunc(Number(stackSize)) || 1);
  const s = Math.max(1, Math.trunc(Number(stack)) || 1);
  const p = Math.max(1, Math.trunc(Number(position)) || 1);
  // Size 1: stack is the divider index. Legacy flat counters lived in
  // startPosition only (stack defaulted to 1) — take the larger.
  if (size === 1) return Math.max(s, Math.min(9999, p));
  return (s - 1) * size + Math.min(size, p);
}

/**
 * Slots inside a box: Location → Stack (divider) → Position.
 * Each row's capture-time snapshot supplies stack, stackSize, and startPosition.
 * Quantity claims consecutive positions; overflowing a stack spills into the next.
 * Mirrors CardVault `_scan_store.js` listing locations.
 */
export function boxSlots(list) {
  const counters = new Map(); // loc -> last absolute index used
  const sizes = new Map(); // loc -> stackSize in force (last seen)
  const slots = new Map();
  for (const row of list || []) {
    const loc = String(row.location ?? '').trim();
    if (!loc) continue;
    const snap = row.defaultsSnapshot || {};
    const size = snapStackSize(snap);
    sizes.set(loc, size);
    const anchor = stackPosToIndex(snapStack(snap), snapPos(snap), size);
    const startAbs = Math.max((counters.get(loc) || 0) + 1, anchor);
    const endAbs = startAbs + (Number(row.quantity) || 1) - 1;
    const start = indexToStackPos(startAbs, size);
    const end = indexToStackPos(endAbs, size);
    const filledStack = size > 1 && (end.stack > start.stack || end.position === size);
    slots.set(row.id, {
      stack: start.stack,
      start: start.position,
      end: end.position,
      endStack: end.stack,
      stackSize: size,
      filledStack,
      absStart: startAbs,
      absEnd: endAbs,
    });
    counters.set(loc, endAbs);
  }
  return slots;
}

/**
 * Next free cursor per location: { stack, startPosition, stackSize }.
 * With stackSize 1, position stays 1 and stack advances each card.
 */
export function nextBoxPositions(list) {
  const next = new Map();
  const slots = boxSlots(list);
  const lastByLoc = new Map();
  for (const row of list || []) {
    const loc = String(row.location ?? '').trim();
    if (!loc) continue;
    const slot = slots.get(row.id);
    if (!slot) continue;
    lastByLoc.set(loc, slot);
  }
  for (const [loc, slot] of lastByLoc) {
    const size = slot.stackSize || 1;
    const nextAbs = slot.absEnd + 1;
    const cur = indexToStackPos(nextAbs, size);
    next.set(loc, {
      stack: cur.stack,
      startPosition: cur.position,
      stackSize: size,
      nextAbs,
    });
  }
  return next;
}

/**
 * Suggested stack/position when the seller switches box (or opens a batch).
 * stored may be a number (legacy absolute) or { stack, startPosition }.
 */
export function suggestedStartPosition({
  stored,
  current = 1,
  locationChanged = false,
} = {}) {
  if (!locationChanged) return null;
  let hint = 0;
  if (stored && typeof stored === 'object') {
    hint = stackPosToIndex(stored.stack || 1, stored.startPosition || 1, stored.stackSize || 1);
  } else {
    hint = Math.trunc(Number(stored)) || 0;
  }
  const now = Math.max(1, Math.trunc(Number(current)) || 1);
  if (hint < 1 || hint === now) return null;
  return Math.min(9999, hint);
}

/** Suggested full cursor (stack + position) when switching boxes. */
export function suggestedStackCursor({
  stored,
  currentStack = 1,
  currentPosition = 1,
  stackSize = 1,
  locationChanged = false,
} = {}) {
  if (!locationChanged) return null;
  const size = Math.max(1, Math.trunc(Number(stackSize)) || 1);
  let hintStack = 0;
  let hintPos = 0;
  if (stored && typeof stored === 'object') {
    hintStack = Math.trunc(Number(stored.stack)) || 0;
    hintPos = Math.trunc(Number(stored.startPosition)) || 0;
  } else {
    const abs = Math.trunc(Number(stored)) || 0;
    if (abs >= 1) {
      const cur = indexToStackPos(abs, size);
      hintStack = cur.stack;
      hintPos = cur.position;
    }
  }
  const nowS = Math.max(1, Math.trunc(Number(currentStack)) || 1);
  const nowP = Math.max(1, Math.trunc(Number(currentPosition)) || 1);
  if (hintStack < 1) return null;
  if (hintStack === nowS && hintPos === nowP) return null;
  return {
    stack: Math.min(9999, hintStack),
    startPosition: size === 1 ? 1 : Math.min(size, Math.max(1, hintPos || 1)),
  };
}

/**
 * Suffix beside the box name.
 * stackSize 1 → `·2` (stack only). Larger → `·2·5` / `·2·5-7`.
 */
export function slotText(slot) {
  if (!slot) return '';
  const size = slot.stackSize || 1;
  if (size === 1) {
    const a = slot.stack || slot.start;
    const b = slot.endStack || slot.stack || slot.end;
    return b > a ? `·${a}-${b}` : `·${a}`;
  }
  const stack = slot.stack || 1;
  if ((slot.endStack || stack) !== stack) {
    return `·${stack}·${slot.start}–${slot.endStack}·${slot.end}`;
  }
  return `·${stack}·${slot.start}${slot.end > slot.start ? `-${slot.end}` : ''}`;
}

/** True when this slot closed out a divider stack (size > 1). */
export function slotFilledStack(slot) {
  return Boolean(slot && slot.filledStack);
}

/** Rows the seller works with: merged repeats live inside their head's qty. */
export function queueRows(rows) {
  return orderedRows(rows).filter((row) => row.status === 'active' || row.status === 'submitted');
}

export function stackKey(row = {}) {
  return [
    String(row.cardId ?? row.card_id ?? ''),
    row.condition || '',
    row.language || '',
    row.foilState ?? row.foil_state ?? '',
    (row.firstEdition ?? row.first_edition) ? '1' : '0',
    row.signed ? '1' : '0',
    row.altered ? '1' : '0',
    row.graded ? '1' : '0',
    row.gradingCompany ?? row.grading_company ?? '',
    row.grade ?? '',
    String(row.location ?? '').trim().toLowerCase(),
  ].join('|');
}

/** Same reasons as CardVault `_scan_connect.submitProblem`. */
export function rowProblem(row, { intent = 'list' } = {}) {
  if (!row || row.status !== 'active') return '';
  if (!/^\d+$/.test(String(row.cardId || ''))) return 'no_printing';
  if ((row.recognitionState === 'ambiguous' || row.recognitionState === 'unmatched') && !row.reviewed) {
    return 'needs_review';
  }
  if (row.graded && (!row.gradingCompany || !row.grade)) return 'grading_incomplete';
  if (intent !== 'collection') {
    const price = Number(row.pricePkn);
    if (row.pricePkn == null || !Number.isFinite(price) || price <= 0) return 'no_price';
  }
  return '';
}

export const PROBLEM_LABEL = {
  no_printing: 'Pick a printing',
  needs_review: 'Check match',
  grading_incomplete: 'Grading details',
  no_price: 'Needs a price',
};

export function batchCounts(rows, { intent = 'list' } = {}) {
  const counts = { rows: 0, cards: 0, needsReview: 0, noPrinting: 0, noPrice: 0, blocked: 0, merged: 0 };
  for (const row of Object.values(rows || {})) {
    if (row.status === 'merged') counts.merged += 1;
    if (row.status !== 'active') continue;
    counts.rows += 1;
    counts.cards += Number(row.quantity) || 0;
    const problem = rowProblem(row, { intent });
    if (problem) counts.blocked += 1;
    if (problem === 'needs_review') counts.needsReview += 1;
    if (problem === 'no_printing') counts.noPrinting += 1;
    if (problem === 'no_price') counts.noPrice += 1;
  }
  counts.ready = counts.rows > 0 && counts.blocked === 0;
  return counts;
}

export function submitLabel(counts, { intent = 'list', targets } = {}) {
  const n = counts.cards;
  if (intent === 'collection') {
    return `Add ${n} card${n === 1 ? '' : 's'} to collection`;
  }
  const pokoin = !targets || targets.pokoin !== false;
  const cardtrader = targets?.cardtrader === true;
  if (pokoin && cardtrader) {
    return `Add ${n} card${n === 1 ? '' : 's'} to Pokoin + CardTrader`;
  }
  if (cardtrader && !pokoin) {
    return `Add ${n} card${n === 1 ? '' : 's'} to CardTrader`;
  }
  return `Add ${n} card${n === 1 ? '' : 's'} to Inventory`;
}

/** Index of the next row after `from` that blocks submit, wrapping once. */
export function nextAttentionIndex(list, from = -1, { intent = 'list' } = {}) {
  const n = list.length;
  for (let step = 1; step <= n; step += 1) {
    const i = (from + step + n) % n;
    if (rowProblem(list[i], { intent })) return i;
  }
  return -1;
}

/**
 * What changed for the seller when a stream frame lands: new rows (scroll),
 * merges (the "Qty 1 → 2 · Undo" toast).
 */
export function frameEvents(before, items) {
  const events = [];
  for (const item of items || []) {
    const previous = before[item.id];
    if (!previous && item.status === 'merged' && item.mergedInto) {
      const head = items.find((row) => row.id === item.mergedInto) || before[item.mergedInto];
      const to = Number(head?.quantity) || 0;
      events.push({ type: 'merged', mergedId: item.id, headId: item.mergedInto, from: to - Number(item.quantity || 1), to });
    } else if (!previous && item.status === 'active') {
      events.push({ type: 'added', id: item.id, recognitionState: item.recognitionState });
    }
  }
  return events;
}

/** Session phase recomputed locally so "Connection lost" appears without a frame. */
export function sessionPhase(session, nowMs, serverOffsetMs = 0) {
  if (!session) return 'none';
  if (session.status === 'ended') return session.endReason === 'expired' ? 'expired' : 'completed';
  if (session.status === 'waiting') return 'waiting';
  const serverNow = nowMs + serverOffsetMs;
  const seen = session.phoneLastSeenAt ? Date.parse(session.phoneLastSeenAt) : 0;
  if (!seen || serverNow - seen >= PHONE_LOST_MS) return 'lost';
  if (session.phase === 'scanning' && serverNow - seen < SCANNING_MS) return 'scanning';
  return 'connected';
}

export function phaseText(phase, session) {
  switch (phase) {
    case 'waiting':
      return { tone: 'wait', text: 'Waiting for phone…' };
    case 'connected':
      return {
        tone: 'ok',
        text: `${session?.phoneLabel || 'Phone'} connected · disconnects after 10 min idle`,
      };
    case 'scanning':
      return { tone: 'ok', text: 'Scanning' };
    case 'lost':
      return { tone: 'warn', text: 'Connection lost — reconnecting' };
    case 'expired':
      return { tone: 'off', text: 'Session expired' };
    case 'completed':
      return { tone: 'off', text: 'Session completed' };
    default:
      return { tone: 'off', text: 'No session' };
  }
}


/** Location chip for defaults: box · stack [· position when stackSize > 1]. */
export function locationDefaultsText(d = DEFAULTS) {
  const loc = String(d.location || '').trim();
  if (!loc) return '';
  const size = Math.max(1, Math.trunc(Number(d.stackSize)) || 1);
  const stack = Math.max(1, Math.trunc(Number(d.stack)) || 1);
  if (size === 1) return `${loc}·${stack}`;
  const pos = Math.max(1, Math.trunc(Number(d.startPosition)) || 1);
  return `${loc}·${stack}·${pos}`;
}

export function defaultsLabel(d = DEFAULTS) {
  const finish = FINISHES.find((f) => f.value === d.foilState);
  return [
    d.language,
    d.condition,
    finish && d.foilState !== 'standard' ? finish.label : '',
    d.firstEdition ? '1st Ed.' : '',
    d.signed ? 'Signed' : '',
    d.altered ? 'Altered' : '',
    d.location ? locationDefaultsText(d) : '',
    `Qty ${d.quantity}`,
  ].filter(Boolean).join(' · ');
}

export function cycleFinish(value, dir = 1) {
  const i = FINISHES.findIndex((f) => f.value === value);
  const n = FINISHES.length;
  return FINISHES[((i < 0 ? 0 : i) + dir + n) % n].value;
}

/** Candidate printings for a row: scanner hits first, then the chosen card. */
export function candidateList(row) {
  const list = (row?.recognition?.candidates || []).map((c) => ({ ...c }));
  if (row?.cardId && !list.some((c) => c.cardId === row.cardId)) {
    list.unshift({ cardId: row.cardId, name: row.cardName, setName: row.setName, number: row.collectorNumber, score: null });
  }
  return list;
}

export function stepCandidate(row, dir) {
  const list = candidateList(row);
  if (list.length < 2) return '';
  const i = Math.max(0, list.findIndex((c) => c.cardId === row.cardId));
  return list[(i + dir + list.length) % list.length].cardId;
}

/** Digit typing into a quantity buffer: "1" then "2" → 12, capped at 99. */
export function typeQuantity(buffer, digit) {
  const next = `${buffer || ''}${digit}`.replace(/^0+/, '').slice(-2);
  const n = Number(next);
  return { buffer: next, quantity: n >= 1 && n <= 99 ? n : null };
}

export function newSubmitKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Per-key network serialization for scan-item patches: run N+1 starts only
 * after run N's response landed, so the server sees intent order even when a
 * handler is slow (patchItem awaits a card lookup before mutating). Without
 * this, "switch version" and the follow-up price suggestion can commit in the
 * wrong order and the card-change price clear wipes the fresh suggestion. */
export function createPatchChain() {
  const tails = new Map();
  return (key, run) => {
    const prev = tails.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(run);
    tails.set(key, next);
    Promise.resolve(next).catch(() => {}).then(() => {
      if (tails.get(key) === next) tails.delete(key);
    });
    return next;
  };
}
