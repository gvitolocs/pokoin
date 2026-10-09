/**
 * React ↔ Solid coexistence. The (future) shell boot script reads
 * `pokoin.ui` and serves the Solid entry only for routes it owns; the rest of
 * the site stays React at the same URLs. `pokoin.ui.once=react` makes the next
 * page load pick React even when the flag says Solid (one-shot handoff).
 */
export const UI_KEY = 'pokoin.ui';
export const UI_ONCE_KEY = 'pokoin.ui.once';

function storage() {
  try {
    return window.localStorage;
  } catch (_) {
    return null;
  }
}

/** True when the shell boot switch is installed (production / combined preview). */
export function hasBootSwitch() {
  return typeof window !== 'undefined' && Boolean(window.__POKOIN_UI_SWITCH__);
}

/** Reload this URL in the React UI. Returns false when there is no switch to hand to. */
export function classicHandoff(href = typeof location === 'undefined' ? '' : location.href) {
  if (!hasBootSwitch() || !href) {
    return false;
  }
  try {
    window.sessionStorage.setItem(UI_ONCE_KEY, 'react');
  } catch (_) {
    /* private mode: the boot switch still honours ?ui=react */
  }
  window.location.replace(href);
  return true;
}

export function preferredUi() {
  return storage()?.getItem(UI_KEY) === 'solid' ? 'solid' : 'react';
}
