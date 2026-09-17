// Scan desk keyboard map. PowerTools Pokémon hotkeys (verified in the
// candyext mirror, module ./Pokemon_hotkeys.json) plus Pokoin gaps.
// Table and reasons: docs/KEYBOARD_SHORTCUTS.md.

/** PowerTools condition keys → Pokoin grades (Cardmarket scale is finer). */
export const CONDITION_KEYS = {
  q: 'NM', // MT: Pokoin has no Mint
  w: 'NM',
  e: 'SP', // EX
  r: 'MP', // GD
  t: 'MP', // LP
  y: 'PL',
  u: 'Poor',
};

/** PowerTools Pokémon language keys → Pokoin language codes. */
export const LANGUAGE_KEYS = {
  a: 'EN',
  s: 'ES',
  d: 'DE',
  f: 'FR',
  g: 'IT',
  h: 'RU',
  j: 'JP',
  k: 'KO',
  l: 'PT',
  m: 'ZHT',
  n: 'NL',
  p: 'PL',
  ']': 'ZH',
  z: 'ID',
  x: 'TH',
};

const TOGGLE_KEYS = { i: 'reverse', o: 'firstEdition', '[': 'signed' };

const CODE_TO_KEY = {
  BracketLeft: '[',
  BracketRight: ']',
};

export function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = String(target.type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(type);
  }
  return false;
}

/**
 * PowerTools scopes hotkeys to the Quantity input of the article being added
 * (`document.activeElement === quantityInputRef`). Digits type quantity;
 * letters are intercepted. Mark that field with data-pokoin-hotkeys="qty".
 */
export function isHotkeyQtyTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const fromDataset = target.dataset && target.dataset.pokoinHotkeys;
  if (fromDataset === 'qty') return true;
  if (typeof target.getAttribute === 'function') {
    return target.getAttribute('data-pokoin-hotkeys') === 'qty';
  }
  return false;
}

/** Physical key for letters/brackets when a modifier changes `event.key`. */
function baseKey(event) {
  const code = String(event.code || '');
  if (CODE_TO_KEY[code]) return CODE_TO_KEY[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return String(event.key || '').length === 1 ? String(event.key).toLowerCase() : String(event.key || '');
}

function attributeCommand(key, target) {
  if (CONDITION_KEYS[key]) return { command: 'set', field: 'condition', value: CONDITION_KEYS[key], target };
  if (LANGUAGE_KEYS[key]) return { command: 'set', field: 'language', value: LANGUAGE_KEYS[key], target };
  if (TOGGLE_KEYS[key]) return { command: 'toggle', field: TOGGLE_KEYS[key], target };
  if (key === '.') return { command: 'cycleFinish', target };
  return null;
}

/**
 * Map a keydown to a scan-desk command, or null to let the browser have it.
 * `context.helpOpen` / `context.modalOpen` / `context.draftActive` narrow what is live.
 * When `draftActive` and focus is the PT Quantity field, attribute keys target `draft`
 * (Enter creates, c creates & copies, Esc/Delete cancel) — candyext single-card KB.
 */
export function shortcutFor(event, context = {}) {
  if (!event || event.defaultPrevented || event.isComposing) return null;
  const key = String(event.key || '');
  const mod = Boolean(event.metaKey || event.ctrlKey);
  const editable = isEditableTarget(event.target);
  const hotkeyQty = isHotkeyQtyTarget(event.target);
  const draftKeys = Boolean(context.draftActive && hotkeyQty);
  const attrTarget = draftKeys ? 'draft' : 'row';

  if (key === 'Escape') return { command: 'cancel' };
  if (context.helpOpen) return key === '?' ? { command: 'help' } : null;
  if (context.modalOpen) return null;

  if (mod) {
    if (event.altKey) return null;
    // Inside a text field ⌘Z is the field's own undo (except the PT qty field).
    if (baseKey(event) === 'z') return editable && !hotkeyQty ? null : { command: event.shiftKey ? 'redo' : 'undo' };
    if (key === 'Enter') return { command: 'submit' };
    return null; // leave browser shortcuts alone
  }

  // Ordinary inputs keep their keys. PowerTools Quantity is the exception.
  if (editable && !hotkeyQty) {
    return null;
  }

  if (hotkeyQty) {
    // Digits / backspace type into Quantity (native), like PT.
    if (/^[0-9]$/.test(key) || key === 'Backspace') return null;
    if (event.altKey) return null;
    if (event.shiftKey) {
      if (key === '?') return { command: 'help' };
      const k = baseKey(event);
      const onDefaults = attributeCommand(k, 'defaults');
      if (onDefaults) return event.repeat ? null : onDefaults;
      return null;
    }
    if (key === 'Enter' || key === ' ') return event.repeat ? null : { command: 'confirm' };
    // PT Esc and Delete both discard the article being added.
    if (key === 'Delete') return event.repeat ? null : { command: 'cancel' };
    if (key === '?') return { command: 'help' };
    if (key === '+' || key === '=') return { command: 'qtyStep', delta: 1 };
    if (key === '-') return { command: 'qtyStep', delta: -1 };
    const k = baseKey(event);
    if (k === 'c') return event.repeat ? null : { command: 'duplicate' };
    const attr = attributeCommand(k, attrTarget);
    if (attr) return event.repeat ? null : attr;
    return null;
  }

  if (event.altKey) {
    const k = baseKey(event);
    if (k === 'ArrowDown') return { command: 'nextAttention' };
    if (/^[1-9]$/.test(k)) return { command: 'pickCandidate', index: Number(k) - 1 };
    if (k === 'l') return { command: 'focusDefault', field: 'location' };
    if (k === 'q') return { command: 'focusDefault', field: 'quantity' };
    if (k === 'p') return { command: 'pause' };
    return null;
  }

  if (event.shiftKey) {
    if (key === '?') return { command: 'help' };
    const k = baseKey(event);
    const onDefaults = attributeCommand(k, 'defaults');
    if (onDefaults) return event.repeat ? null : onDefaults;
    if (key === '+') return { command: 'qtyStep', delta: 1 };
    return null;
  }

  switch (key) {
    case 'Enter':
    case ' ':
      return event.repeat ? null : { command: 'confirm' };
    case 'Delete':
      return event.repeat ? null : { command: 'remove' };
    case 'Backspace':
      return { command: 'qtyBackspace' };
    case 'ArrowUp':
      return { command: 'move', delta: -1 };
    case 'ArrowDown':
      return { command: 'move', delta: 1 };
    case 'ArrowLeft':
      return { command: 'candidate', delta: -1 };
    case 'ArrowRight':
      return { command: 'candidate', delta: 1 };
    case '/':
      return { command: 'replace' };
    case '?':
      return { command: 'help' };
    case '+':
    case '=':
      return { command: 'qtyStep', delta: 1 };
    case '-':
      return { command: 'qtyStep', delta: -1 };
    default:
      break;
  }
  if (/^[0-9]$/.test(key)) return { command: 'qtyDigit', digit: key };
  const k = baseKey(event);
  if (k === 'v') return { command: 'move', delta: -1 };
  if (k === 'b') return { command: 'move', delta: 1 };
  if (k === 'c') return event.repeat ? null : { command: 'duplicate' };
  const attr = attributeCommand(k, 'row');
  if (attr) return event.repeat ? null : attr;
  return null;
}

/** On-screen legend while Qty is focused (PT `data-testid="hotkey-legend"`). */
export const DRAFT_HOTKEY_LEGEND = {
  condition: Object.entries(CONDITION_KEYS).map(([key, value]) => ({
    key,
    code: `Key${key.toUpperCase()}`,
    kind: 'condition',
    value,
    label: value,
  })),
  language: Object.entries(LANGUAGE_KEYS).map(([key, value]) => ({
    key,
    code: key === ']' ? 'BracketRight' : `Key${key.toUpperCase()}`,
    kind: 'language',
    value,
    label: value,
  })),
  toggles: [
    { key: 'i', code: 'KeyI', kind: 'toggle', field: 'reverse', label: 'Rev' },
    { key: 'o', code: 'KeyO', kind: 'toggle', field: 'firstEdition', label: '1st' },
    { key: '[', code: 'BracketLeft', kind: 'toggle', field: 'signed', label: 'Signed' },
    { key: '.', code: 'Period', kind: 'cycleFinish', label: 'Finish' },
  ],
  actions: [
    { key: 'Enter', code: 'Enter', kind: 'action', command: 'confirm', label: 'Create' },
    { key: 'c', code: 'KeyC', kind: 'action', command: 'duplicate', label: 'Create & copy' },
    { key: 'Esc', code: 'Escape', kind: 'action', command: 'cancel', label: 'Cancel' },
  ],
};

/** Whether a legend chip matches the article being added (PT active border). */
export function draftLegendActive(entry, draft) {
  if (!draft || !entry) return false;
  if (entry.kind === 'condition') return draft.condition === entry.value;
  if (entry.kind === 'language') return draft.language === entry.value;
  if (entry.kind === 'toggle') {
    if (entry.field === 'reverse') return draft.foilState === 'reverse';
    return Boolean(draft[entry.field]);
  }
  if (entry.kind === 'cycleFinish') return draft.foilState && draft.foilState !== 'standard';
  return false;
}

/**
 * Fire the same keydown the seller would type into Qty (PT legend buttons
 * `dispatchEvent` on `document.activeElement`). Bubbles to the scan desk map.
 */
export function dispatchDraftHotkey(target, entry) {
  if (!target || !entry || typeof target.dispatchEvent !== 'function') return false;
  if (typeof target.focus === 'function') target.focus();
  const key = entry.key === 'Esc' ? 'Escape' : entry.key === 'Enter' ? 'Enter' : entry.key;
  const event = new KeyboardEvent('keydown', {
    key,
    code: entry.code || '',
    bubbles: true,
    cancelable: true,
  });
  return target.dispatchEvent(event);
}

/** Rows for the `?` overlay, grouped. Kept next to the map so they cannot drift. */
export const HELP_SECTIONS = [
  {
    title: 'Add card (PowerTools)',
    rows: [
      ['Name field', 'Search (same engine as header), Enter picks a printing'],
      ['q w e r t y u', 'Condition on the article being added'],
      ['a s d f g h j k l m n p ] z x', 'Language on the article being added'],
      ['i / o / [', 'Reverse · 1st edition · Signed'],
      ['0–9', 'Quantity (type in the Qty field)'],
      ['Enter / Space', 'Create — add to the queue'],
      ['c', 'Create & copy — add, keep card for another identity'],
      ['Esc / Delete', 'Cancel the article being added'],
    ],
  },
  {
    title: 'Queue row',
    rows: [
      ['Same letter keys', 'Edit the focused row when Qty is not focused'],
      ['Enter / Space', 'Confirm match, go to next that needs review'],
      ['c', 'Copy row as another version'],
      ['Delete', 'Remove scan (undo with ⌘Z)'],
      ['v / b · ↑ / ↓', 'Previous / next row'],
      ['← / →', 'Previous / next candidate printing'],
      ['Alt 1–9', 'Pick candidate'],
      ['.', 'Cycle finish'],
      ['/', 'Replace printing (search)'],
      ['Shift + row key', 'Same change on the Batch Defaults'],
    ],
  },
  {
    title: 'Pokoin',
    rows: [
      ['Alt ↓', 'Next row that needs attention'],
      ['Alt L / Alt Q', 'Default location / quantity'],
      ['Alt P', 'Pause / resume phone'],
      ['⌘Z / ⇧⌘Z', 'Undo / redo'],
      ['⌘Enter', 'Add to Inventory'],
      ['?', 'This help'],
    ],
  },
];
