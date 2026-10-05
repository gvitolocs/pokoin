import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { fetchCardTraderStatus } from '../api.js';
import { useAuth } from '../auth.jsx';

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

/** Shared Listings / Collection / Sold / Bought / import strip under the MyPokoin desk. */
export default function StockNav({ forceActive = '' } = {}) {
  const { signedIn, getBearer } = useAuth();
  const [oneDayReady, setOneDayReady] = useState(cachedOneDayReady);

  useEffect(() => {
    if (!signedIn) return undefined;
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
    return () => { cancelled = true; };
  }, [signedIn, getBearer]);

  const tabs = TABS.filter((tab) => {
    if (tab.account === '1dr') return oneDayReady === true;
    if (tab.account === 'zero') return oneDayReady === false;
    return true;
  });

  return (
    <nav className="stock-nav" aria-label="MyPokoin">
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end === true}
          className={({ isActive }) => (isActive || (forceActive && tab.label === forceActive) ? 'on' : undefined)}
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
