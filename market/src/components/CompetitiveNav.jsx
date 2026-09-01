import { Link, useLocation } from 'react-router-dom';
import { COMP_NAV, competitiveData } from '../competitive.js';

export default function CompetitiveNav() {
  const location = useLocation();
  const data = competitiveData();
  const active = COMP_NAV.find((row) => row.match(location.pathname));
  const title = !active || active.label === 'Overview' ? 'Competitive' : active.label;
  return (
    <div className="comp-head">
      <div>
        <p className="eyebrow">Competitive</p>
        <h1>{title}</h1>
        <p className="muted">{data.formatLabel} · candyext Limitless snapshot, not live sync</p>
      </div>
      <nav className="comp-tabs" aria-label="Competitive">
        {COMP_NAV.map((row) => (
          <Link key={row.to} className={row.match(location.pathname) ? 'on' : undefined} to={row.to}>
            {row.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
