import { onSettled } from 'solid-js';

export const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * What a modal owes the keyboard, in one place: the first control gets focus
 * while the dialog is open, Escape closes it, focus goes back to whatever
 * opened it when it goes away, and Tab can stay inside it.
 *
 * Returns the handler for the backdrop's `onKeyDown`; `dialog` gives the
 * dialog element focus is kept inside. options: `onClose`, `first` (element to
 * focus instead of the first control), `trap` (keep Tab inside; on unless off).
 */
export function useDialogFocus(dialog, options = {}) {
  const trap = options.trap !== false;
  onSettled(() => {
    const opener = document.activeElement;
    const box = dialog();
    (options.first?.() || box?.querySelector(FOCUSABLE))?.focus();
    return () => {
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  });
  return (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      options.onClose?.();
      return;
    }
    const box = dialog();
    if (!trap || event.key !== 'Tab' || !box) return;
    const items = [...box.querySelectorAll(FOCUSABLE)].filter((node) => node.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!box.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };
}
