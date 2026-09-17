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
 * `context.helpOpen` / `context.modalOpen` narrow what is live.
 */
export function shortcutFor(event, context = {}) {
  if (!event || event.defaultPrevented || event.isComposing) return null;
  const key = String(event.key || '');
  const mod = Boolean(event.metaKey || event.ctrlKey);
  const editable = isEditableTarget(event.target);

  if (key === 'Escape') return { command: 'cancel' };
  if (context.helpOpen) return key === '?' ? { command: 'help' } : null;
  if (context.modalOpen) return null;

  if (mod) {
    if (event.altKey) return null;
    // Inside a text field ⌘Z is the field's own undo.
    if (baseKey(event) === 'z') return editable ? null : { command: event.shiftKey ? 'redo' : 'undo' };
    if (key === 'Enter') return { command: 'submit' };
    return null; // leave browser shortcuts alone
  }
  if (editable) {
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

/** Rows for the `?` overlay, grouped. Kept next to the map so they cannot drift. */
export const HELP_SECTIONS = [
  {
    title: 'Row (PowerTools keys)',
    rows: [
      ['q w e r t y u', 'Condition NM · NM · SP · MP · MP · PL · Poor'],
      ['a s d f g h j k l m n p ] z x', 'Language EN ES DE FR IT RU JP KO PT ZHT NL PL ZH ID TH'],
      ['i', 'Reverse holo on / off'],
      ['o', '1st edition on / off'],
      ['[', 'Signed on / off'],
      ['0–9', 'Quantity'],
      ['Enter / Space', 'Confirm match, go to next that needs review'],
      ['c', 'Copy row as another version'],
      ['Delete', 'Remove scan (undo with ⌘Z)'],
      ['v / b', 'Previous / next row'],
    ],
  },
  {
    title: 'Pokoin',
    rows: [
      ['↑ / ↓', 'Previous / next row'],
      ['Alt ↓', 'Next row that needs attention'],
      ['← / →', 'Previous / next candidate printing'],
      ['Alt 1–9', 'Pick candidate'],
      ['.', 'Cycle finish'],
      ['+ / −', 'Quantity ±1'],
      ['/', 'Replace printing (search)'],
      ['Shift + row key', 'Same change on the Batch Defaults'],
      ['Alt L / Alt Q', 'Default location / quantity'],
      ['Alt P', 'Pause / resume phone'],
      ['⌘Z / ⇧⌘Z', 'Undo / redo'],
      ['⌘Enter', 'Add to Inventory'],
      ['?', 'This help'],
    ],
  },
];
