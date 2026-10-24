import { createEffect, createSignal, For, Show } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { fetchCardTraderStatus } from '@market/api.js';
import { getBearer, signedIn } from '../stores/auth.js';

const TABS = [
  { to: '/mypokoin', label: 'Listings', end: true, icon: 'M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z' },
  { to: '/mypokoin/collection', label: 'Collection', end: true, icon: 'M6 4h9a2 2 0 0 1 2 2v14l-6.5-2.8L4 20V6a2 2 0 0 1 2-2z' },
  { to: '/mypokoin/picked', label: 'Picked', end: true, icon: 'M4 7h16v12H4zM9 12.5l2 2 4-4.5M8 7V4h8v3' },
  { to: '/mypokoin/import', label: 'Export', end: true, icon: 'M12 4v10M8 10l4 4 4-4M5 19h14' },
  { to: '/mypokoin/spreadsheet', label: 'Spreadsheet', end: true, icon: 'M5 4h14v16H5zM5 9h14M5 14h14M10 4v16' },
  { to: '/sales', label: 'Sold history', icon: 'M5 12.5 9.5 17 19 7' },
  { to: '/bought', label: 'Buy history', icon: 'M6 7h15l-1.5 9h-12zM6 7 5 4H3M9 20.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM17 20.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z' },
  { to: '/mypokoin/zero', label: 'CardTrader Zero', end: true, account: 'zero', icon: 'M4 8h16v11H4zM8 8V5.5h8V8M9 12h6' },
  { to: '/mypokoin/1dr', label: 'CardTrader 1-DR', end: true, account: '1dr', icon: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z' },
  { to: '/inventory/sync-review', label: 'CT ↔ Power Tools', icon: 'M7 7h11M15 4l3 3-3 3M17 17H6M9 14l-3 3 3 3' },
  { to: '/mypokoin/settings', label: 'Settings', icon: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6.1 6.1l1.6 1.6M16.3 16.3l1.6 1.6M17.9 6.1l-1.6 1.6M7.7 16.3l-1.6 1.6' },
];

let cachedOneDayReady;

function accountIsOneDayReady(data) {
  const meta = data?.status?.metadata;
  const mode = data?.sync?.summary?.mode;
  return meta?.oneDayReady === true || mode === 'one_day_ready';
}

function TabIcon(props) {
  return (
    <svg class="stock-nav-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path d={props.d} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** Shared Listings / Collection / Sold / Bought / import strip under the MyPokoin desk. */
export default function StockNav(props) {
  const location = useLocation();
  const [oneDayReady, setOneDayReady] = createSignal(cachedOneDayReady);

  createEffect(signedIn, (on) => {
    if (!on) return undefined;
    if (cachedOneDayReady !== undefined) {
      setOneDayReady(cachedOneDayReady);
      return undefined;
    }
    let cancelled = false;
    getBearer()
      .then((token) => fetchCardTraderStatus(token))
      .then((data) => {
        cachedOneDayReady = accountIsOneDayReady(data);
        if (!cancelled) setOneDayReady(cachedOneDayReady);
      })
      .catch(() => {
        cachedOneDayReady = false;
        if (!cancelled) setOneDayReady(false);
      });
    return () => {
      cancelled = true;
    };
  });

  const tabs = () => TABS.filter((tab) => {
    if (tab.account === '1dr') return oneDayReady() === true;
    if (tab.account === 'zero') return oneDayReady() === false;
    return true;
  });
  // React NavLink: `end` matches the path exactly, otherwise any deeper path too.
  const active = (tab) => {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    return path === tab.to || (!tab.end && path.startsWith(`${tab.to}/`));
  };
  const lede = () => props.lede || 'Your listings, collection, and sales.';

  return (
    <div class="mypokoin mypokoin-shell">
      <header class="mypokoin-head">
        <div class="mypokoin-copy">
          <p class="page-kicker">Seller</p>
          <h1 class="page-title">{props.title || 'MyPokoin'}</h1>
          <p class="page-lede">{lede()}</p>
        </div>
        <Show when={props.children}>
          <div class="page-actions mypokoin-actions">{props.children}</div>
        </Show>
      </header>
      <Show when={props.metrics?.length}>
        <div class="mypokoin-metrics">
          <For each={props.metrics}>
            {(metric) => (
              <div class="mypokoin-metric">
                <strong>{metric.value}</strong>
                <span>{metric.label}</span>
                <Show when={metric.hint}><small>{metric.hint}</small></Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <nav class="stock-nav" aria-label="MyPokoin">
        <For each={tabs()}>
          {(tab) => (
            <a
              href={tab.to}
              class={{ on: active(tab) || Boolean(props.forceActive && tab.label === props.forceActive) }}
              aria-current={active(tab) ? 'page' : undefined}
            >
              <TabIcon d={tab.icon} />
              {tab.label}
            </a>
          )}
        </For>
      </nav>
    </div>
  );
}
