import { NavLink } from 'react-router-dom';

const TABS = [
  { to: '/mypokoin', label: 'Listings', end: true },
  { to: '/mypokoin/import', label: 'Import / export', end: true },
  { to: '/sales', label: 'Sold history' },
  { to: '/bought', label: 'Buy history' },
  { to: '/inventory/sync-review', label: 'CT ↔ Power Tools' },
];

/** Shared Listings / Sold / Bought / import strip under the MyPokoin desk. */
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
