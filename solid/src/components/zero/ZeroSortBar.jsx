import { createSignal, For, Show } from 'solid-js';
import { chooseSortField, SORT_LEVELS, SORT_OPTIONS, sortLevelEnabled } from '@market/zero-sort.js';

const LEVELS = Array.from({ length: SORT_LEVELS }, (_, level) => level);

/**
 * Power Tools' "Sort by" row: 4 dropdowns, Apply sort, Reset, and the Smart
 * locations switch. The dropdowns are a draft until Apply sort; a field used
 * twice is refused with Power Tools' message.
 */
export default function ZeroSortBar(props) {
  // Writable memo: the draft follows the applied sort whenever that changes.
  const [draft, setDraft] = createSignal(() => [...(props.fields || [])]);
  const [error, setError] = createSignal('');

  function choose(level, value, select) {
    const result = chooseSortField(draft(), level, value);
    if (result.error) {
      setError(result.error);
      select.value = draft()[level];
      return;
    }
    setError('');
    setDraft(result.fields);
  }

  return (
    <div class="zero-sort" role="group" aria-label="Sort by">
      <div class="zero-sort-row">
        <span class="zero-sort-label">Sort by</span>
        <For each={LEVELS}>
          {(level) => (
            <label class="zero-sort-level">
              <span class="sr-only">Sort level {level + 1}</span>
              <select
                value={draft()[level] || 'none'}
                disabled={!sortLevelEnabled(draft(), level) || props.busy}
                onChange={(event) => choose(level, event.target.value, event.target)}
              >
                <For each={SORT_OPTIONS}>
                  {(option) => <option value={option.value} selected={(draft()[level] || 'none') === option.value}>{option.label}</option>}
                </For>
              </select>
            </label>
          )}
        </For>
        <button class="btn" type="button" disabled={props.busy} onClick={() => props.onApply(draft())}>
          {props.busy ? 'Applying…' : 'Apply sort'}
        </button>
        <button class="btn ghost" type="button" disabled={props.busy} onClick={() => { setError(''); props.onReset(); }}>Reset</button>
      </div>
      <Show when={error()}><p class="zero-sort-error" role="alert">{error()}</p></Show>
      <p class="zero-sort-hint thread-meta">Click Apply sort to update the list on CardTrader too</p>
      <label class="zero-smart" title="When a card sits in several boxes: on, Pokoin picks the box (the sold copy first, then the oldest); off, you choose.">
        <input
          type="checkbox"
          role="switch"
          checked={props.smartLocations !== false}
          disabled={props.busy}
          onChange={(event) => props.onSmartLocations(event.target.checked)}
        />
        <span>Smart locations</span>
        <small class="thread-meta">
          {props.smartLocations !== false
            ? 'Each card shows the box Pokoin chose.'
            : 'Cards in several boxes show every box; choose the one you picked from.'}
        </small>
      </label>
    </div>
  );
}
