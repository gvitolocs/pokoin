/**
 * The seller's saved collections, as a store the desk can subscribe to.
 *
 * Framework-free on purpose: the rules that have a test — who the state
 * belongs to, what a failed load leaves, whose answer replaces the state after
 * a write — are decided here once, and the Solid wrapper in
 * `solid/src/lib/collections-book.js` only mirrors them into signals.
 *
 * The I/O is injected, so the same store runs against the three
 * `/api/marketplace-portfolio-collections` calls and, on `/dashboard?dashPreview`,
 * against the fixture with no request at all.
 */

import {
  collectionErrorMessage,
  draftErrors,
  emptyCollections,
  errorCode,
  normalizeCollections,
  saveBody,
} from './portfolio-collections.js';

function snapshot(extra) {
  return {
    uid: '',
    // Nothing of this seller has been asked for and come back yet: neither an
    // answer nor a failure. See publish(), which decides the level from it.
    settled: false,
    pending: false,
    saving: '',
    error: '',
    ...emptyCollections(),
    // The level does not exist yet; publish() fills both in from one rule.
    levelModel: null,
    atLimit: false,
    ...extra,
  };
}

/**
 * `deps`:
 * - `bearer()` — the signed-in seller's token, or '' when there is none;
 * - `fetchCollections(token)` / `saveCollection(token, body)` / `deleteCollection(token, id)`;
 * - `previewAnswer(collections)` — the fixture's own answer for a list of saved
 *   collections: with it the store never asks the network and writes memory.
 */
export function createCollectionsStore(deps = {}) {
  const preview = typeof deps.previewAnswer === 'function';
  let state = snapshot();
  const watchers = new Set();
  let seq = 0;

  function publish(next) {
    // The two questions the table asks of every state — is there a Collections
    // level to draw, and is the New button dead — are answered here, so the
    // wrapper mirrors values instead of re-deriving them outside the signals.
    state = {
      ...next,
      // A level exists once the seller's own lists have been asked for and the
      // desk knows the outcome — including a failure, which is a level with a
      // line in it. A retry settles nothing new, so the level stays on screen
      // while it is out.
      levelModel: next.settled ? next.model : null,
      atLimit: next.collections.length >= next.limits.collections,
    };
    for (const fn of [...watchers]) fn(state);
  }

  function get() {
    return state;
  }

  function subscribe(fn) {
    watchers.add(fn);
    return () => watchers.delete(fn);
  }

  /** Nothing of the previous seller is left to paint. */
  function reset(extra = {}) {
    publish(snapshot({ ...extra }));
  }

  /** The API's answer is the whole state, the write it was waiting for included. */
  function apply(uid, data) {
    publish({
      ...state,
      uid,
      settled: true,
      pending: false,
      saving: '',
      error: '',
      ...normalizeCollections(data),
    });
  }

  /** A failure is an outcome too: the level stays, with its line and a retry. */
  function fail(message) {
    publish({ ...state, settled: true, pending: false, error: message });
  }

  function load(uid) {
    const clean = String(uid || '');
    // The fixture has no seller behind it: it answers whoever asks.
    if (preview) {
      apply(clean, deps.previewAnswer(state.collections));
      return Promise.resolve(state);
    }
    if (!clean) {
      seq += 1;
      reset();
      return Promise.resolve(state);
    }
    const run = seq + 1;
    seq = run;
    // A different seller: everything of the previous one goes before anything
    // of theirs can paint. The uid is claimed at once so a failed load can be
    // retried by the button that says “Try again”.
    if (state.uid !== clean) reset({ pending: true, uid: clean });
    // The same seller, so a retry: what is on screen stays there, un-errored,
    // and the bar says it is working.
    else publish({ ...state, pending: true, error: '' });
    return Promise.resolve()
      .then(() => deps.bearer())
      .then((token) => {
        if (!token) throw new Error('no bearer');
        return deps.fetchCollections(token);
      })
      .then(
        (data) => {
          if (run !== seq) return state;
          apply(clean, data);
          return state;
        },
        (err) => {
          // A list that never answered is still a level, with its own line and
          // a retry: the graph and the other levels are untouched by it.
          if (run === seq) fail(collectionErrorMessage(errorCode(err), {
            fallback: 'Could not load your collections.',
            limits: state.limits,
          }));
          return state;
        },
      )
      .finally(() => {
        // Only a run that never got an answer of its own still holds the flag.
        if (run === seq && state.pending) publish({ ...state, pending: false });
      });
  }

  function reload() {
    return load(state.uid);
  }

  /** The draft's own problems; the list it renames is not a taken name. */
  function validate(draft) {
    const others = state.collections.filter((row) => row.id !== String(draft?.id || ''));
    return draftErrors(draft, others, state.limits);
  }

  function atLimit() {
    return state.collections.length >= state.limits.collections;
  }

  /**
   * Which seller a write was made for, and where the request line stood when it
   * started. Every load takes the line — another seller, a sign-out, a refresh —
   * so this is how a write learns that nobody is waiting for its answer any more.
   */
  function owner() {
    return { uid: state.uid, seq };
  }

  function overtaken(run) {
    return run.uid !== state.uid || run.seq !== seq;
  }

  function savedBody(draft) {
    const clean = saveBody(draft);
    return { ...clean, name: String(clean.name || '').trim() };
  }

  /**
   * Save `draft`, a new list or the one it names. The POST answer is the whole
   * state: no second GET follows a write. A draft the server refuses comes back
   * as the sentence to show above the fields, and the draft itself stays.
   */
  function save(draft) {
    const problems = validate(draft);
    if (problems.length) return Promise.resolve({ ok: false, message: problems[0] });
    if (preview) {
      const clean = savedBody(draft);
      const here = state.collections.findIndex((row) => row.id === clean.id);
      const saved = here >= 0
        ? state.collections.map((row, index) => (index === here ? { ...row, ...clean } : row))
        : [...state.collections, { ...clean, id: `preview-${state.collections.length + 1}`, createdAt: '', updatedAt: '' }];
      apply(state.uid, deps.previewAnswer(saved));
      return Promise.resolve({ ok: true, saved: saved[here >= 0 ? here : saved.length - 1].id });
    }
    const key = String(draft?.id || '') || 'new';
    const run = owner();
    publish({ ...state, saving: key });
    return Promise.resolve()
      .then(() => deps.bearer())
      .then((token) => {
        // The seller is gone by the time we would have asked: nothing goes out.
        if (overtaken(run)) throw new Error('gone');
        if (!token) throw new Error('no bearer');
        return deps.saveCollection(token, savedBody(draft));
      })
      .then(
        (data) => {
          // An answer of the previous seller never lands on the new one.
          if (overtaken(run)) return { ok: false, message: 'Could not save the collection.' };
          apply(run.uid, data);
          return { ok: true, saved: String(data?.saved || '') || String(draft?.id || '') };
        },
        (err) => {
          if (overtaken(run)) return { ok: false, message: 'Could not save the collection.' };
          return { ok: false, message: collectionErrorMessage(errorCode(err), { limits: state.limits }) };
        },
      )
      .finally(() => {
        // The answer already cleared it; only a write that never answered has to,
        // and never one whose seller has been replaced.
        if (!overtaken(run) && state.saving) publish({ ...state, saving: '' });
      });
  }

  function remove(id) {
    const clean = String(id || '');
    if (!clean) return Promise.resolve({ ok: false, message: 'Which collection should go?' });
    if (preview) {
      apply(state.uid, deps.previewAnswer(state.collections.filter((row) => row.id !== clean)));
      return Promise.resolve({ ok: true, saved: '' });
    }
    const run = owner();
    publish({ ...state, saving: clean });
    return Promise.resolve()
      .then(() => deps.bearer())
      .then((token) => {
        if (overtaken(run)) throw new Error('gone');
        if (!token) throw new Error('no bearer');
        return deps.deleteCollection(token, clean);
      })
      .then(
        (data) => {
          if (overtaken(run)) return { ok: false, message: 'Could not delete the collection.' };
          apply(run.uid, data);
          return { ok: true, saved: '' };
        },
        (err) => {
          if (overtaken(run)) return { ok: false, message: 'Could not delete the collection.' };
          return { ok: false, message: collectionErrorMessage(errorCode(err), {
            fallback: 'Could not delete the collection.',
            limits: state.limits,
          }) };
        },
      )
      .finally(() => {
        // The answer already cleared it; only a write that never answered has to.
        if (!overtaken(run) && state.saving) publish({ ...state, saving: '' });
      });
  }

  /**
   * The segments sub-model for the Collections level, or null when the level
   * has nothing to say yet: not before the first answer of this seller, and
   * not while a load of theirs is still out.
   */
  function model() {
    return state.levelModel;
  }

  return {
    atLimit,
    get,
    load,
    model,
    reload,
    remove,
    save,
    subscribe,
    validate,
  };
}
