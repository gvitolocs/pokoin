import { NavLink } from 'react-router-dom';

const TABS = [
  { to: '/mypokoin', label: 'MyPokoin', end: true },
  { to: '/mypokoin/import', label: 'Import / export', end: true },
  { to: '/sales', label: 'Sold history' },
  { to: '/bought', label: 'Buy history' },
  { to: '/inventory/sync-review', label: 'CT ↔ Power Tools' },
];

/** Shared MyPokoin / Sold / Bought / import strip for the stock desk pages. */
export default function StockNav() {
  return (
    <nav className="stock-nav" aria-label="MyPokoin">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end === true}
          className={({ isActive }) => (isActive ? 'on' : undefined)}
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
