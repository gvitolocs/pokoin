/**
 * The client-side half of Batch defaults: what the seller has already done to
 * the Location field, and whether the stack setup is switched Off. The server
 * has no notion of either — an empty location is a clear, and a stack size is
 * always at least 1 — so both are remembered in this browser, keyed by batch id,
 * and survive a reload. Pure: the localStorage text goes in and out.
 */

/** localStorage key of `{ [batchId]: { locationTouched, stackOff } }`. */
export const BATCH_FLAGS_KEY = 'scan:batch-defaults';

/**
 * Stack setup Off waits for the server to hold an off value: `normalize_defaults`
 * clamps `stackSize` to 1..9999, so an off batch would submit `box1` while the
 * desk row says `box1·7` — a location the listing will not have. While this is
 * false the desk never offers the choice: no Off chip, an emptied "Cards per
 * stack" restores its number, the gear never greys from stack-off, and rows
 * keep the suffix the listing will really have. The Off rules stay and their
 * tests run with the flag forced on, passed as a parameter.
 */
export const STACK_SETUP_OFF_ENABLED = false;

/** `{ batchId: {…} }` out of stored JSON; junk, arrays and null become empty. */
export function parseBatchFlags(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(raw || ''));
  } catch (_) {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [batchId, entry] of Object.entries(parsed)) {
    if (!batchId || !entry || typeof entry !== 'object') continue;
    const flags = {};
    if (entry.locationTouched === true) flags.locationTouched = true;
    if (entry.stackOff === true) flags.stackOff = true;
    if (Object.keys(flags).length) out[batchId] = flags;
  }
  return out;
}

export function serializeBatchFlags(flags) {
  return JSON.stringify(flags && typeof flags === 'object' ? flags : {});
}

/** Entries kept: a seller starts batches all day, the store must not grow with them. */
export const MAX_TRACKED_BATCHES = 200;

/** Turn one flag on or off for one batch; an entry with no flag left is pruned. */
export function setBatchFlag(flags, batchId, name, value) {
  if (!batchId) return flags;
  const next = { ...(flags || {}) };
  const entry = { ...(next[batchId] || {}) };
  if (value) entry[name] = true;
  else delete entry[name];
  // Object key order is insertion order: re-inserting puts the batch the desk
  // is working on at the end, so dropping from the front only ever drops the
  // batches it is done with.
  delete next[batchId];
  if (Object.keys(entry).length) next[batchId] = entry;
  const ids = Object.keys(next);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_TRACKED_BATCHES))) delete next[id];
  return next;
}

export function batchFlag(flags, batchId, name) {
  const entry = (flags || {})[batchId];
  return Boolean(entry && entry[name] === true);
}

/**
 * The box the seed would suggest, or '' for nothing to suggest. It is a
 * suggestion only — never a defaults write: a value the seller did not choose
 * has no business in the Location field, and the desk used to overwrite a box
 * that was still being typed with it. Once the seller has touched the field in
 * this batch (typed, picked or cleared) the seed is silent for good.
 */
export function locationSuggestion({ boxes, location, touched }) {
  if (String(location || '').trim()) return '';
  if (touched) return '';
  const list = Array.isArray(boxes) ? boxes : [];
  for (const entry of list) {
    const box = typeof entry === 'string' ? entry : String(entry?.box || '');
    if (box.trim()) return box.trim();
  }
  return '';
}

/**
 * A scan is the seller accepting the suggestion: they put a card in a box, so
 * the box they were shown becomes the default. Blur and Enter accept it too.
 */
export function acceptSuggestion({ suggestion, location, touched }) {
  if (!suggestion || touched || String(location || '').trim()) return null;
  return { location: suggestion };
}

/** Clearing the Location means "no location": the field is greyed and rows get none. */
export const LOCATION_OFF_PATCH = Object.freeze({ location: '' });

/**
 * Stack setup Off, in the closest value today's server accepts: one card per
 * stack. `normalize_defaults` clamps a stack size below 1 back to 1, so there
 * is no "no stack setup" on the wire yet and the desk keeps the Off choice
 * itself: the gear says Off and the rows show the plain box name.
 */
export const STACK_OFF_PATCH = Object.freeze({ stackSize: 1 });

/**
 * What "Cards per stack" means when the seller leaves the field: emptied is an
 * explicit Off, never "keep the old number" — but only while the server can
 * hold the off value (`offEnabled`). Until then an emptied field is a keep: the
 * bar restores the number it had, because Off is not on offer.
 */
export function sizeCommit(raw, offEnabled = STACK_SETUP_OFF_ENABLED) {
  const text = String(raw ?? '').trim();
  if (!text) return offEnabled ? { kind: 'off' } : { kind: 'keep' };
  const n = Number.parseInt(text, 10);
  if (!(n >= 1 && n <= 9999)) return { kind: 'invalid' };
  return { kind: 'size', size: n };
}

/**
 * Whether a draft field still shows what the seller is typing. While the field
 * has focus their text wins: a defaults answer — the seed, a fan-out, the
 * cursor — describes the value from before they finished.
 */
export function draftValue({ focused, draft, serverValue }) {
  return focused ? draft : serverValue;
}

/**
 * The draft to apply right now because a card is about to be created with it:
 * any text that is not the value in force, including an emptied field.
 */
export function pendingDraft({ draft, applied }) {
  return String(draft ?? '') === String(applied ?? '') ? null : String(draft ?? '');
}

/**
 * The stack half of the split answer, which leaves with its new box in ONE
 * patch. A seller's own stack edit may skip its write when the number already
 * matches the current stack; here that skip would lose the number, because a
 * location patch without a stack gets the stack from the box's stock instead.
 * So the stack the seller named is always carried, even `6` onto a stack `6`.
 * The position follows their own edit: with no divider it anchors at 1; with a
 * divider the cursor of a box nobody has entered yet is the desk's to answer,
 * so the patch carries no position and the one in force stays.
 */
export function stackSplitPatch({ wanted, size }) {
  const stack = Math.min(9999, Math.max(1, Math.trunc(Number(wanted)) || 1));
  return Number(size) === 1 ? { stack, startPosition: 1 } : { stack };
}

/**
 * The greyed state and screen-reader text of the Location field. Off means the
 * batch has no box: the field stays focusable and says how to switch it back on.
 */
export function locationFieldState({ location, suggestion }) {
  const off = !String(location || '').trim();
  return {
    off,
    placeholder: off ? suggestion : '',
    title: off
      ? (suggestion
        ? `No Location set. Box of your newest listing: ${suggestion} — leave the field or scan a card to use it, or type another box.`
        : 'No Location set: new rows get no location. Type a box to set one.')
      : 'The box new cards of this batch go in. Clear it for no location.',
  };
}

/**
 * The gear: greyed with no number while the stack setup is Off (or there is no
 * box to stack in), and its title always says how to switch it back on. A
 * stack-off request only takes while `offEnabled` says the server can hold it.
 */
export function gearState({ off, offEnabled = STACK_SETUP_OFF_ENABLED, size, stack, startPosition, locationOff }) {
  const stackOff = Boolean(off) && offEnabled;
  const greyed = Boolean(stackOff || locationOff);
  const n = Math.max(1, Math.trunc(Number(size)) || 1);
  if (greyed) {
    return {
      greyed,
      showSize: false,
      title: stackOff
        ? 'Stack setup is Off — cards keep the box name only. Choose cards per stack to switch it on.'
        : 'No Location set — type a box and the stack setup switches on.',
    };
  }
  return {
    greyed,
    showSize: n > 1,
    title: `Stack setup — ${n === 1 ? 'one card per stack' : `${n} cards per stack`}, stack ${stack}${n > 1 ? `, next position ${startPosition}` : ''}`,
  };
}

/** Off = the plain box name: no row of the batch shows a stack or position suffix. */
export function displaySlots(slots, { off, offEnabled = STACK_SETUP_OFF_ENABLED } = {}) {
  const stackOff = Boolean(off) && offEnabled;
  if (!stackOff) return slots instanceof Map ? slots : new Map();
  return new Map();
}

/** "No location": the batch default is empty, so rows get no location at all. */
export function isLocationOff(defaults) {
  return !String(defaults?.location || '').trim();
}
