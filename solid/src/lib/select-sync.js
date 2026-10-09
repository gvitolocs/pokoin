import { createEffect } from 'solid-js';

/**
 * Keep a <select> on `value()` after its options change (a filter restored on
 * back, or chosen before the list that offers it has loaded). React re-applies
 * `value` on every render; this re-applies it whenever the value or the
 * option list changes, and like React DOM a value with no option shows the
 * first one. Call in the component body; bind the result as the select's ref.
 * Same rule as the private helper in components/SearchToolbar.jsx.
 */
export function syncSelect(value, options) {
  let el;
  const apply = (next) => {
    if (!el) return;
    el.value = next;
    if (el.selectedIndex < 0 && el.options.length) el.selectedIndex = 0;
  };
  createEffect(() => [value(), options ? options() : null], ([next]) => {
    apply(next);
  });
  return (node) => {
    el = node;
  };
}
