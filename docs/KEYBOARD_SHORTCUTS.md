# Keyboard shortcuts (Scan desk)

Keyboard map for `pokoin.com/inventory/scan`. PowerTools keys are copied
where the meaning survives the Pokoin model, so a PowerTools seller can
work without relearning. Every PowerTools row below is **verified** in the
mirror bundle `candyext/dump/site/new.tcgpowertools.com/static/js/main.1fff971d.chunk.js`
(module `./Pokemon_hotkeys.json` = webpack module 953, and the add-article
handlers) or in `candyext/dump/kb_articles.json`. Code:
`market/src/scan-shortcuts.js`, tests `market/src/scan-shortcuts.test.js`.
Matrix: [POWERTOOLS_FEATURE_MATRIX.md](POWERTOOLS_FEATURE_MATRIX.md).

## How PowerTools scopes hotkeys (verified)

Handlers are registered with `useHotkeys`-style calls and wrapped in a guard:

```
(!disabled && document.activeElement === quantityInputRef.current || force) && (preventDefault(), stopPropagation(), run())
```

So PowerTools hotkeys **only fire while the Quantity input of the article
being added has focus**. Digits type the quantity; letters are not numbers,
so they are free for attributes. The helper text under that input switches
between "Use hotkeys to edit the article" and "Click this field to edit the
article". **Tab** cycles Quantity ↔ Comment inside `#article-edit-container`.
The on-screen legend buttons dispatch the same `keydown` to the focused
element, so mouse and keyboard run one code path.

Pokoin keeps the idea: shortcuts fire only when focus is on the **scan
queue grid** (or nothing editable is focused on the scan page). Inputs,
selects, textareas and `contenteditable` never receive a shortcut.

## PowerTools Pokémon keys → Pokoin

| Shortcut | PT context | PowerTools behaviour | Pokoin equivalent | Conflict | Proposed handling |
| --- | --- | --- | --- | --- | --- |
| `q` | add article | condition = **MT** | condition = **NM** | Pokoin has no Mint grade | Bind to NM; the row chip shows NM at once |
| `w` | add article | condition = **NM** | NM | — | same |
| `e` | add article | condition = **EX** | **SP** | scale differs | Bind; Cardmarket EX ≈ Pokoin Slightly Played |
| `r` | add article | condition = **GD** | **MP** | scale differs | Bind |
| `t` | add article | condition = **LP** | **MP** | two PT grades → one Pokoin grade | Bind; lossy, shown on the chip |
| `y` | add article | condition = **PL** | **PL** | — | Bind |
| `u` | add article | condition = **PO** | **Poor** | — | Bind |
| `i` | add article | toggle `finishType` Regular ↔ **ReverseHolo** | toggle `foil_state` standard ↔ **reverse** | — | Bind |
| `o` | add article | toggle **isFirstEd** | toggle `first_edition` | — | Bind |
| `[` | add article | toggle **isSigned** | toggle `signed` | — | Bind (`event.code BracketLeft`, layout-safe) |
| `a` | add article | language English | `EN` | — | Bind |
| `s` | add article | Spanish | `ES` | — | Bind |
| `d` | add article | German | `DE` | — | Bind |
| `f` | add article | French | `FR` | — | Bind |
| `g` | add article | Italian | `IT` | — | Bind |
| `h` | add article | Russian | `RU` | — | Bind |
| `j` | add article | Japanese | `JP` | — | Bind |
| `k` | add article | Korean | `KO` | — | Bind |
| `l` | add article | Portuguese | `PT` | — | Bind |
| `m` | add article | T-Chinese | `ZHT` | — | Bind |
| `n` | add article | Dutch | `NL` | — | Bind |
| `p` | add article | Polish | `PL` | — | Bind |
| `]` | add article | S-Chinese | `ZH` | — | Bind (`BracketRight`) |
| `z` | add article | Indonesian | `ID` | — | Bind |
| `x` | add article | Thai | `TH` | — | Bind |
| `Enter`, `Space` | add article | create the article; in the stock edit panel `Enter` is registered with the force flag, so it confirms even when Quantity is not focused | **confirm** the focused row (ambiguous → accepted) and move to the next row needing review | — | Bind |
| `c` | add article | create & copy: add the article, keep it selected for another identity | **duplicate** the focused row as a new article (same printing, qty 1) and focus the copy | — | Bind |
| `Delete` | add article | cancel (discard the article being added) | **remove** the focused scan row (Undo restores) | — | Bind |
| `Esc` | add article (single-card) | cancel | close popover / clear the qty buffer; **never deletes** | PT discards on Esc | Deviate on purpose: Esc deletes nothing on a batch of hundreds |
| `v` | by expansion | previous card | previous row | — | Bind |
| `b` | by expansion | next card (skip) | next row | — | Bind |
| digits | add article | typed into Quantity | set focused row quantity (buffer, 1–99) | — | Bind |
| `Tab` | add article | Quantity ↔ Comment | move between row cells | — | Browser default inside the grid |
| `Shift+Click` | inventory / listing | select a range | select a range of rows | — | Bind (mouse) |
| `Enter` | dialogs, set price / qty / comment popovers | submit | submit popover | — | Browser default |
| `v`, `Enter` | Price Suggest | reset suggest / accept price | — | not in scan desk | Not bound |

Not bound because no Pokoin field exists: Pokémon **Playset** (no hotkey in
PT either), **country edition** (PT has none for Pokémon; `n` = US only in
Yu-Gi-Oh!). Vietnamese (`VI`) has no PT key; menu only.

## UNKNOWN (not found in the mirror)

| Wanted operation | Result of the search |
| --- | --- |
| Undo in the add-article panel | **UNKNOWN** — only "Discard Changes" toolbar icon (KB), no key binding in the bundle |
| Save / Publish shortcut | **UNKNOWN** — no key handler; mouse only |
| Focus search | **UNKNOWN** — no global binding; the Name field autofocuses |
| Printing / finish "other types" | **UNKNOWN** as a key — PT uses a `<select>` ("Other finish types") |
| Location | **UNKNOWN** as a key — text field only |
| Help overlay | none — PT shows a permanent on-screen hotkey legend instead |

## Pokoin-specific keys (gaps only)

| Shortcut | Context | Behaviour | Why this key |
| --- | --- | --- | --- |
| `↑` / `↓` | queue | previous / next row | Arrow keys; `v`/`b` also work |
| `Alt+↓` | queue | next row that needs review (ambiguous / unmatched / no price) | keeps letter keys for PT |
| `←` / `→` | queue | previous / next **candidate printing** of the focused row | PT uses arrows to move in its search list |
| `Alt+1` … `Alt+9` | queue | pick candidate N | digits are quantity (PT) |
| `.` | queue | cycle finish: standard → holo → reverse → stamped → promo → other | `i` stays reverse toggle |
| `+` / `-` | queue | quantity +1 / −1 | digits replace; +/- adjust |
| `/` | queue | open **Replace printing** search on the focused row | common "search" key; unused by PT |
| `Shift` + any PT attribute key | queue | set the **Batch Default** instead of the row (`Shift+G` = default Italian, `Shift+W` = default NM, `Shift+I` = default finish reverse, `Shift+O` default 1st ed.) | one mental map: same key, Shift = whole pile |
| `Alt+L` | scan page | focus the Batch Default **Location** field | letter `l` is Portuguese |
| `Alt+Q` | scan page | focus the Batch Default **Quantity** | |
| `Alt+P` | scan page | pause / resume accepting phone scans | |
| `Mod+Z` / `Mod+Shift+Z` | scan page | undo / redo the last queue change (delete, qty merge, edit) | platform standard |
| `Mod+Enter` | scan page | open **Add N cards to Inventory** confirmation | PT Save is mouse-only |
| `?` | scan page | shortcut help overlay | common convention; `Shift+/` by `event.key` |

`Mod` is ⌘ on macOS and Ctrl elsewhere. Letter shortcuts use `event.code`
when a modifier is held (macOS `Alt+L` types `¬`), `event.key` otherwise.

## TCGplayer Quicklist (concept only)

No TCGplayer artifact exists locally, so no TCGplayer key is claimed here.
Patterns taken conceptually: scan or type → the item lands in a running
list immediately; the most common attributes are one keystroke on the
active row; the list is reviewed and priced as a whole before it is
committed; nothing blocks the next scan. Pokoin's own design system and keys
above implement those patterns.
