/**
 * React legacy tripwire. The site is Solid only: whatever once picked the React
 * UI (a `?ui=react` link, a stored `pokoin.ui` React preference, a
 * `pokoin.ui.once` handoff) is cleared and named here, and App reports the
 * reason as a `[react-legacy]` client error (console + POST /api/client-error),
 * so tests, crawls and the API journal show where React is still referenced.
 * Stored values are removed, so a visitor reports once.
 */
export const UI_KEY = 'pokoin.ui';
export const UI_ONCE_KEY = 'pokoin.ui.once';

/** The reason this load would once have been React ('' when none). Clears the stored keys. */
export function reactLegacyReason({ search = '', local = null, session = null } = {}) {
  let why = '';
  try {
    if (new URLSearchParams(search).get('ui') === 'react') why = 'ui=react';
  } catch {
    /* malformed query: nothing to report */
  }
  try {
    const once = session?.getItem(UI_ONCE_KEY);
    if (once) {
      session.removeItem(UI_ONCE_KEY);
      why ||= `handoff:${once}`;
    }
  } catch {
    /* storage blocked */
  }
  try {
    const pref = local?.getItem(UI_KEY);
    if (pref) {
      local.removeItem(UI_KEY);
      if (pref.startsWith('react')) why ||= `pref:${pref}`;
    }
  } catch {
    /* storage blocked */
  }
  return why;
}

function storage(name) {
  try {
    return window[name];
  } catch {
    return null;
  }
}

/** Run once at boot: names the reason on window.__POKOIN_REACT_LEGACY__ for App to report. */
export function installReactLegacyTripwire() {
  const why = reactLegacyReason({
    search: window.location.search,
    local: storage('localStorage'),
    session: storage('sessionStorage'),
  });
  if (why) window.__POKOIN_REACT_LEGACY__ = why;
  return why;
}
