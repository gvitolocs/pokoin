import { SEARCH_TABS, normalizeSearchTab } from '../search-kind.js';

export default function SearchTabs({
  value = 'singles',
  onChange,
  counts = null,
  ariaLabel = 'Search type',
}) {
  const current = normalizeSearchTab(value);
  return (
    <div className="search-tabs" role="tablist" aria-label={ariaLabel}>
      {SEARCH_TABS.map((tab) => {
        const count = counts?.[tab.id];
        const selected = current === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`search-tab-${tab.id}`}
            aria-selected={selected}
            className={selected ? 'on' : undefined}
            onClick={() => onChange?.(tab.id)}
          >
            {tab.label}
            {Number.isFinite(count) ? (
              <em>{count.toLocaleString('en-US')}</em>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
