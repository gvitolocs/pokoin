import { createEffect, createSignal, For } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { fetchCardTraderStatus } from '@market/api.js';
import { getBearer, signedIn } from '../stores/auth.js';

const TABS = [
  { to: '/mypokoin', label: 'Listings', end: true },
  { to: '/mypokoin/collection', label: 'Collection', end: true },
  { to: '/mypokoin/import', label: 'Export', end: true },
  { to: '/mypokoin/spreadsheet', label: 'Spreadsheet', end: true },
  { to: '/sales', label: 'Sold history' },
  { to: '/bought', label: 'Buy history' },
  { to: '/mypokoin/zero', label: 'CardTrader Zero', end: true, account: 'zero' },
  { to: '/mypokoin/1dr', label: 'CardTrader 1-DR', end: true, account: '1dr' },
  { to: '/inventory/sync-review', label: 'CT ↔ Power Tools' },
  { to: '/mypokoin/settings', label: 'Settings' },
];

let cachedOneDayReady;

function accountIsOneDayReady(data) {
  const meta = data?.status?.metadata;
  const mode = data?.sync?.summary?.mode;
  return meta?.oneDayReady === true || mode === 'one_day_ready';
}

/** Shared Listings / Collection / Sold / Bought / import strip under the MyPokoin desk (market/src/components/StockNav.jsx). */
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

  return (
    <nav class="stock-nav" aria-label="MyPokoin">
      <For each={tabs()}>
        {(tab) => (
          <a
            href={tab.to}
            class={{ on: active(tab) || Boolean(props.forceActive && tab.label === props.forceActive) }}
            aria-current={active(tab) ? 'page' : undefined}
          >
            {tab.label}
          </a>
        )}
      </For>
    </nav>
  );
}
