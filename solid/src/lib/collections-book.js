import { createSignal, onCleanup } from 'solid-js';
import { deletePortfolioCollection, fetchPortfolioCollections, savePortfolioCollection } from '@market/api.js';
import { createCollectionsStore } from '@market/portfolio-collections-store.js';
import { getBearer } from '../stores/auth.js';

/**
 * The saved collections behind the Dashboard's Collections level, in signals.
 *
 * The rules — what a switch of seller drops, what a failed load leaves, whose
 * answer replaces the state after a write — live in
 * `@market/portfolio-collections-store.js`, where each has a test; this wrapper
 * mirrors the state into one signal and adds the single UI question the level
 * asks: which list the editor is showing.
 *
 * Everything a page *draws* reads `view()`, so it is tracked: `atLimit()` and
 * `model()` in the store are plain closures, and a table that called them
 * directly would never learn that an answer arrived. The commands (`load`,
 * `save`, `remove`, `reload`, `validate`) may ask the store itself.
 *
 * The page calls `load(uid)` from its own effect, and it is a request of its
 * own: the graph never waits for it and it never waits for the graph.
 * `previewAnswer` switches the whole thing to the fixture, where a save or a
 * delete rewrites memory and asks nothing.
 */
export function createCollectionsBook({ previewAnswer = null } = {}) {
  const store = createCollectionsStore({
    bearer: () => getBearer(),
    fetchCollections: fetchPortfolioCollections,
    saveCollection: savePortfolioCollection,
    deleteCollection: deletePortfolioCollection,
    ...(typeof previewAnswer === 'function' ? { previewAnswer } : {}),
  });
  const [view, setView] = createSignal(store.get());
  const [editing, setEditing] = createSignal(null);
  const stop = store.subscribe(setView);
  onCleanup(stop);

  function load(uid) {
    // A new seller, or none at all: their lists replace what is on screen,
    // and the editor of the previous one closes with them.
    if (String(uid || '') !== store.get().uid) setEditing(null);
    return store.load(uid);
  }

  /** The button is dead at the limit; the store decides it with every state. */
  const atLimit = () => view().atLimit;

  function openNew() {
    if (store.atLimit()) return;
    setEditing({ id: '' });
  }

  /** Only a list this seller has can be edited; the draft comes from `saved`. */
  function openEdit(id) {
    const clean = String(id || '');
    if (!view().collections.some((row) => row.id === clean)) return;
    setEditing({ id: clean });
  }

  function closeEdit() {
    setEditing(null);
  }

  function save(draft) {
    return store.save(draft).then((result) => {
      // A refused draft leaves the dialog and what is typed in it alone.
      if (result.ok) setEditing(null);
      return result;
    });
  }

  function remove(id) {
    return store.remove(id).then((result) => {
      if (result.ok && editing()?.id === String(id || '')) setEditing(null);
      return result;
    });
  }

  const saved = () => view().collections.find((row) => row.id === editing()?.id) || null;

  return {
    atLimit,
    closeEdit,
    collections: () => view().collections,
    editing,
    error: () => view().error,
    limits: () => view().limits,
    load,
    /** The Collections level's own segments model, or null while there is none. */
    model: () => view().levelModel,
    openEdit,
    openNew,
    pending: () => view().pending,
    reload: () => store.reload(),
    remove,
    save,
    saving: () => view().saving,
    saved,
    validate: (draft) => store.validate(draft),
  };
}
