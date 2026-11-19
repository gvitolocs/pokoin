/**
 * A box name that ends in a number has two readings: the number belongs to the
 * name, or it is the stack index inside that box. Nothing here chooses — the
 * seller does. The module names the ambiguity, spells both readings the same
 * way on every surface, and remembers the answer for the browser. The server
 * implements the same rule for the CSV import. No framework imports.
 */

/** Marks that make the text an already-structured location, never a bare name. */
const LOCATION_MARKS = ['·', '•', '#'];

/** `FUOCOBOMBA 006 - 16`: the dash says which number is the stack, so nothing is guessed. */
const EXPLICIT_DASH = /^(.+?)\s+-\s+(\d+)$/;

/** A trailing number, with what the seller typed between the name and it. */
const TRAILING_NUMBER = /^(.+?)[\s_]+(\d+)$/;

/** The question the import dialog puts above the three readings. */
export const LOCATION_ASK_QUESTION = 'Some locations end in a number. Is that number part of the box name?';

/** Why the import button waits while no reading is chosen. */
export const LOCATION_ASK_PENDING = 'Pick one of the three readings above to import.';

/** The server's refusal of an import whose location style was never confirmed. */
export const LOCATION_STYLE_UNCONFIRMED = 'location_style_unconfirmed';

/** Answers this browser keeps: the exact name the seller typed → 'box' | 'stack'. */
export const BOX_NAME_CHOICE_KEY = 'pokoin.boxNameChoice.v1';

const clampStack = (value) => Math.min(9999, Math.max(1, Math.trunc(Number(value)) || 1));

/**
 * `{ raw, asBox, asStack: { box, stack } }` when the text ends in a number that
 * could be the stack index without the seller having said so, else null.
 */
export function ambiguousBoxName(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (LOCATION_MARKS.some((mark) => text.includes(mark))) return null;
  if (EXPLICIT_DASH.test(text)) return null;
  const hit = TRAILING_NUMBER.exec(text);
  if (!hit) return null;
  const head = hit[1].trim();
  if (!/[a-z]/i.test(head)) return null;
  return { raw: text, asBox: text, asStack: { box: head, stack: clampStack(hit[2]) } };
}

/** The two readings as the import dialog lists them. */
export function locationReadingLabels(reading) {
  return {
    asBox: `box ${reading.asBox}`,
    asStack: `box ${reading.asStack.box}, stack ${reading.asStack.stack}`,
  };
}

/** The two readings as the pop-up's buttons. */
export function boxNameChoiceLabels(reading) {
  return {
    asBox: `Box "${reading.asBox}"`,
    asStack: `Box "${reading.asStack.box}", stack ${reading.asStack.stack}`,
  };
}

/** The pop-up's question about a name the seller has just typed. */
export function boxNameAskTitle(reading) {
  return `New box "${reading.asBox}"?`;
}

/** The name out of a box list entry: a bare name, or `{ box }`. */
function entryName(entry) {
  return typeof entry === 'string' ? entry.trim() : String(entry?.box ?? '').trim();
}

/** The number the seller actually wrote, before any clamping, or null. */
function stackNumberAsWritten(text) {
  const hit = TRAILING_NUMBER.exec(text);
  return hit ? Number(hit[2]) : null;
}

/** The names this browser has an answer for, whatever shape the caller holds them in. */
function answeredNames(answered) {
  if (!answered || typeof answered !== 'object') return [];
  if (Array.isArray(answered)) return answered.map((name) => String(name));
  if (answered instanceof Set || answered instanceof Map) return [...answered.keys()].map(String);
  return Object.keys(answered).map(String);
}

/**
 * Ask only for a name that is ambiguous, is not one of the seller's own boxes
 * and has not been answered before — the answer is stored per exact name. A
 * number that is not a stack the seller could have meant (0, or past 9999) is
 * never offered: the name is kept whole and nothing is asked.
 */
export function shouldAskBoxName({ name, boxes, answered } = {}) {
  const reading = ambiguousBoxName(name);
  if (!reading) return false;
  const written = stackNumberAsWritten(reading.raw);
  if (!(written >= 1 && written <= 9999)) return false;
  const owned = (Array.isArray(boxes) ? boxes : []).map(entryName).filter(Boolean);
  if (owned.some((box) => box.toLowerCase() === reading.raw.toLowerCase())) return false;
  if (answeredNames(answered).some((asked) => String(asked).trim() === reading.raw)) return false;
  return true;
}

/** One example of an answer, re-read by this rule so both sides say the same thing. */
function normalizeExample(entry) {
  const raw = typeof entry === 'string' ? entry : String(entry?.raw ?? '');
  const derived = ambiguousBoxName(raw);
  if (derived) return derived;
  const box = String(entry?.asStack?.box ?? '').trim();
  const stack = Number(entry?.asStack?.stack);
  if (!box || !Number.isFinite(stack)) return null;
  const text = raw.trim();
  return { raw: text, asBox: String(entry?.asBox ?? text).trim() || text, asStack: { box, stack: clampStack(stack) } };
}

function examplesOf(answer) {
  const carried = Array.isArray(answer.ambiguousExamples)
    ? answer.ambiguousExamples
    : (Array.isArray(answer.locationExamples) ? answer.locationExamples : [])
      .filter((value) => ambiguousBoxName(value));
  return carried.map(normalizeExample).filter(Boolean).slice(0, 3);
}

/**
 * Whether an analyze or sync answer makes the seller confirm how their
 * locations are read, and the examples to show. An API older than the site
 * carries none of these fields: its `locationExamples` is only a sample, so an
 * empty sample proves nothing, and the detected `trailing_stack` — the one mode
 * in which a trailing number is split — decides on its own. With no ambiguous
 * example to show, the question comes without example rows. When the server
 * does carry `confirmationNeeded`, its answer decides, as before.
 */
export function needsLocationConfirmation(answer) {
  const carried = answer && typeof answer === 'object' ? answer : {};
  const examples = examplesOf(carried);
  const needed = typeof carried.confirmationNeeded === 'boolean'
    ? carried.confirmationNeeded
    : (examples.length > 0 || String(carried.locationParse || '') === 'trailing_stack');
  const count = Number(carried.ambiguousCount);
  return { needed, count: Number.isFinite(count) && count > 0 ? count : examples.length, examples };
}

/** The refusal this dialog answers with its question instead of an error line. */
export function isLocationStyleUnconfirmed(err) {
  if (Number(err?.status) !== 409) return false;
  const body = err?.body && typeof err.body === 'object' ? err.body : {};
  return String(body.error || '') === LOCATION_STYLE_UNCONFIRMED;
}

/** What that refusal asks: the same question, and it is always owed an answer. */
export function locationAskFromRefusal(err) {
  return { ...needsLocationConfirmation(err?.body), needed: true };
}

/**
 * The style an import sends: what the seller picked. Nothing is sent while a
 * confirmation is owed and nobody has answered — the detected style is a guess,
 * and `null` says so. Without a confirmation the dialog keeps its old reading.
 */
export function locationParseToSend({ chosen, detected, needed } = {}) {
  const picked = String(chosen || '');
  if (picked && picked !== 'auto') return picked;
  if (needed) return null;
  return String(detected || '') || 'as_is';
}

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch (_) {
    return null;
  }
}

const CHOICES = ['box', 'stack'];

/**
 * The stored answers that count: a plain object of exact name → `box` or
 * `stack`. An array, a string, null or any other value is read as no answer,
 * so a damaged entry cannot silently suppress the question or block a write.
 */
function validChoices(entries) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return {};
  const clean = {};
  for (const [name, value] of Object.entries(entries)) {
    if (CHOICES.includes(value)) clean[name] = value;
  }
  return clean;
}

/** The answers kept in this browser; an unreadable or missing store is none. */
export function readBoxNameChoices() {
  const store = storage();
  if (!store) return {};
  try {
    return validChoices(JSON.parse(store.getItem(BOX_NAME_CHOICE_KEY) || '{}'));
  } catch (_) {
    return {};
  }
}

/** Keep the answer for this exact name. Nothing is thrown when storage is off. */
export function rememberBoxNameChoice(name, choice) {
  const text = String(name ?? '').trim();
  if (!text || (choice !== 'box' && choice !== 'stack')) return false;
  const store = storage();
  if (!store) return false;
  try {
    // Built from the validated read, so a malformed stored value is replaced
    // by a clean object instead of being written back around the new answer.
    const answers = { ...readBoxNameChoices(), [text]: choice };
    store.setItem(BOX_NAME_CHOICE_KEY, JSON.stringify(answers));
    return true;
  } catch (_) {
    return false;
  }
}
