import { NavLink } from 'react-router-dom';

const TABS = [
  { to: '/inventory', label: 'Inventory', end: true },
  { to: '/sales', label: 'Sold history' },
  { to: '/bought', label: 'Buy history' },
  { to: '/inventory/sync-review', label: 'CT ↔ Power Tools' },
];

/** Shared Inventory / Sold / Bought strip for the stock desk pages. */
export default function StockNav() {
  return (
    <nav className="stock-nav" aria-label="Stock">
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
