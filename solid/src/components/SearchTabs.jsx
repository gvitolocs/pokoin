import { For, Show } from 'solid-js';
import { SEARCH_TABS, normalizeSearchTab } from '@market/search-kind.js';

/** Singles / Product / Users tabs (market/src/components/SearchTabs.jsx). */
export default function SearchTabs(props) {
  const current = () => normalizeSearchTab(props.value);
  return (
    <div class="search-tabs" role="tablist" aria-label={props.ariaLabel || 'Search type'}>
      <For each={SEARCH_TABS}>
        {(tab) => (
          <button
            type="button"
            role="tab"
            id={`search-tab-${tab.id}`}
            aria-selected={(current() === tab.id) ? 'true' : 'false'}
            class={{ on: current() === tab.id }}
            onClick={() => props.onChange?.(tab.id)}
          >
            {tab.label}
            <Show when={Number.isFinite(props.counts?.[tab.id])}>
              <em>{props.counts[tab.id].toLocaleString('en-US')}</em>
            </Show>
          </button>
        )}
      </For>
    </div>
  );
}
