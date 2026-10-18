/**
 * The typeahead popup across one typing session (SearchBox.jsx).
 *
 * Once the popup has opened it stays up until Escape, an outside click, a
 * pick / search, or an empty field: it no longer follows every keystroke's
 * readiness. While the next query has no rows yet (the term trailing the
 * input by a paint, Meili or a catalog hydration in flight, a keystroke back
 * under the three-letter threshold) it keeps the rows it last painted, so the
 * list never collapses to "Searching…" and back between letters. Rows are
 * keyed by card id, so held rows keep their nodes and images. A settled empty
 * result still clears them ("No singles match").
 *
 * `scope` is the tab + print family the rows were ranked for: rows from
 * another scope are never held over.
 */
export const SUGGEST_SESSION_CLOSED = Object.freeze({ held: false, visible: false, scope: '', rows: [] });

export function nextSuggestSession(session, {
  open = false,
  query = '',
  ready = false,
  pending = false,
  rows = [],
  scope = '',
  pokemon = true,
} = {}) {
  const prev = session || SUGGEST_SESSION_CLOSED;
  if (!open || !String(query || '').trim()) {
    return prev === SUGGEST_SESSION_CLOSED ? prev : SUGGEST_SESSION_CLOSED;
  }
  const holdRows = !rows.length && prev.rows.length > 0 && prev.scope === scope && (pending || !ready);
  const shown = holdRows ? prev.rows : rows;
  const visible = prev.held
    ? shown.length > 0 || ready || pending
    : ready && (pokemon || rows.length > 0 || pending);
  if (prev.held === visible && prev.visible === visible && prev.scope === scope && prev.rows === shown) {
    return prev;
  }
  return { held: visible, visible, scope, rows: shown };
}
