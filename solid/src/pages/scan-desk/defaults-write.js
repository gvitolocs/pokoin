/**
 * Batch-defaults writes: the sequencing rules of `setDefaults`, kept pure so a
 * response can be replayed against the state it was generated from. The server
 * is last-write-wins and hands back a whole batch view plus a `defaultsVersion`
 * the desk used to ignore, so an answer that arrived late spread an older
 * defaults snapshot over a newer one — a default that "cannot be switched off".
 */

/** Keys the server rewrites as a consequence of another key in the same patch. */
const COUPLED = {
  stackSize: ['stack', 'startPosition'],
  stack: ['startPosition'],
  startPosition: ['stack'],
  pricingGroupId: ['pricingStrategyId'],
  pricingStrategyId: ['pricingGroupId'],
};

/** Batch fields a defaults answer must never own. */
const NOT_FROM_DEFAULTS = new Set(['defaults', 'defaultsVersion', 'status', 'submitResult']);

const FIELD_NAME = {
  game: 'Game',
  language: 'Language',
  condition: 'Condition',
  foilState: 'Finish',
  firstEdition: '1st Ed.',
  signed: 'Signed',
  altered: 'Altered',
  location: 'Location',
  stack: 'Current stack',
  stackSize: 'Cards per stack',
  startPosition: 'Next position',
  mergeRepeats: 'Merge repeats',
  pricingGroupId: 'Pricing',
  pricingStrategyId: 'Pricing',
};

/** The keys an answer may speak for: the ones this write set, plus what the server couples to them. */
export function affectedKeys(patch = {}) {
  const keys = new Set(Object.keys(patch));
  for (const key of [...keys]) {
    for (const extra of COUPLED[key] || []) keys.add(extra);
  }
  return keys;
}

/** A `defaultsVersion` as a number; absent or null is "this answer does not say". */
function asVersion(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** What a box-stock request is about: the batch, the box, and the desk's own key. */
function stockTarget({ batchId, box, key }) {
  return { batchId: String(batchId || ''), box: String(box || ''), key: String(key || '') };
}

/**
 * Whether a box-stock answer may still move the desk. Every slot the desk
 * computes comes out of one `boxStock`, so an answer of the box that was typed
 * before — or of another batch — would price the next scan against stock that
 * is not in the box on screen at all.
 */
export function stockAnswerIsForBox(asked, now) {
  const a = stockTarget(asked);
  const n = stockTarget(now);
  return Boolean(a.batchId) && a.batchId === n.batchId && a.box === n.box && a.key === n.key;
}

/**
 * Merge one `action=defaults` answer into the batch. An answer older than the
 * newest already applied is dropped whole; a newer one only replaces the keys
 * its own request touched, and never the batch status (submit and the stream
 * close a batch, a late defaults answer must not reopen one).
 */
export function applyDefaultsResponse(prev, { patch = {}, view = null } = {}) {
  if (!prev) return prev;
  if (!view) return prev;
  const version = asVersion(view.defaultsVersion);
  const applied = asVersion(prev.defaultsVersion);
  if (version != null && applied != null && version < applied) return prev;
  const serverDefaults = view.defaults || {};
  const keys = affectedKeys(patch);
  const defaults = { ...(prev.defaults || {}) };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(serverDefaults, key)) defaults[key] = serverDefaults[key];
  }
  const next = { ...prev, defaults };
  for (const [key, value] of Object.entries(view)) {
    if (!NOT_FROM_DEFAULTS.has(key)) next[key] = value;
  }
  if (version != null && (applied == null || version >= applied)) next.defaultsVersion = version;
  return next;
}

/**
 * Undo an optimistic defaults write whose request failed. Only the keys that
 * write touched go back, so a default changed in between by another control
 * survives; a key the batch did not have before is dropped again.
 */
export function rollbackDefaults(current, snapshot, patch = {}) {
  const defaults = { ...(current?.defaults || {}) };
  const before = snapshot || {};
  for (const key of affectedKeys(patch)) {
    if (Object.prototype.hasOwnProperty.call(before, key)) defaults[key] = before[key];
    else delete defaults[key];
  }
  return { ...(current || {}), defaults };
}

/** What a failed save says: the control that was reverted, by name. */
export function defaultsFailureMessage(patch = {}) {
  const names = [...new Set(Object.keys(patch).map((key) => FIELD_NAME[key]).filter(Boolean))];
  return `${names.length ? names.join(' / ') : 'That batch default'} not saved — reverted.`;
}
