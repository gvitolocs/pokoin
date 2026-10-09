import { createEffect, For, Show } from 'solid-js';
import { PRINT_LANGS, setPrintLang } from '@market/locale.js';
import { printLang } from '../stores/locale.js';

function FieldLabel(props) {
  return (
    <Show when={props.compact} fallback={props.children}>
      <span class="sr-only">{props.children}</span>
    </Show>
  );
}

/**
 * Keeps a select on its value after its options change. A rarity or set
 * restored on back arrives before the results that list it; React re-applies
 * `value` on every render, so do the same — and like React DOM, a value with
 * no option shows the first one. Call in the component body; bind the
 * returned callback as the select's ref.
 */
function syncSelect(value, options) {
  let el;
  const apply = (next) => {
    if (!el) return;
    el.value = next;
    if (el.selectedIndex < 0 && el.options.length) el.selectedIndex = 0;
  };
  createEffect(() => [value(), options ? options() : null], ([next]) => apply(next));
  return (node) => {
    el = node;
  };
}

/** Print / Sort / (Type) / Rarity / Set selects (market/src/components/SearchToolbar.jsx). */
export default function SearchToolbar(props) {
  const rarities = () => props.rarities || [];
  const sets = () => props.sets || [];
  const printRef = syncSelect(printLang);
  const sortRef = syncSelect(() => props.sort);
  const typeRef = syncSelect(() => props.type ?? 'all');
  const rarityRef = syncSelect(() => props.rarity, rarities);
  const setRef = syncSelect(() => props.setName, sets);
  return (
    <div class="toolbar-right">
      <Show when={props.showPrint}>
        <label class="sort">
          <FieldLabel compact={props.compact}>Print</FieldLabel>
          <select
            aria-label="Card print"
            ref={printRef}
            onChange={(event) => setPrintLang(event.target.value)}
          >
            <For each={PRINT_LANGS}>{(item) => <option value={item.code}>{item.label}</option>}</For>
          </select>
        </label>
      </Show>
      <label class="sort">
        <FieldLabel compact={props.compact}>Sort</FieldLabel>
        <select ref={sortRef} onChange={(event) => props.onSort(event.target.value)}>
          <option value="match">Best match</option>
          <option value="pokedex">Pokédex</option>
          <option value="price-asc">Price: low</option>
          <option value="price-desc">Price: high</option>
          <option value="name">Name</option>
        </select>
      </label>
      <Show when={typeof props.onType === 'function'}>
        <label class="sort">
          <FieldLabel compact={props.compact}>Type</FieldLabel>
          <select ref={typeRef} onChange={(event) => props.onType(event.target.value)}>
            <option value="all">All</option>
            <option value="singles">Singles</option>
            <option value="sealed">Sealed</option>
          </select>
        </label>
      </Show>
      <label class="sort">
        <FieldLabel compact={props.compact}>Rarity</FieldLabel>
        <select ref={rarityRef} onChange={(event) => props.onRarity(event.target.value)}>
          <option value="">All</option>
          <For each={rarities()}>{(value) => <option value={value}>{value}</option>}</For>
        </select>
      </label>
      <label class="sort">
        <FieldLabel compact={props.compact}>Set</FieldLabel>
        <select ref={setRef} onChange={(event) => props.onSet(event.target.value)}>
          <option value="">All</option>
          <For each={sets()}>{(value) => <option value={value}>{value}</option>}</For>
        </select>
      </label>
      <Show when={props.filtersOn}>
        <button class="linkish" type="button" onClick={() => props.onClear()}>
          Clear
        </button>
      </Show>
    </div>
  );
}
