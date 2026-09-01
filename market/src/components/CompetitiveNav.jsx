import { Link, useLocation } from 'react-router-dom';
import { COMP_NAV, competitiveData } from '../competitive.js';
import { PageHead } from './Desk.jsx';

export default function CompetitiveNav() {
  const location = useLocation();
  const data = competitiveData();
  const active = COMP_NAV.find((row) => row.match(location.pathname));
  const title = !active || active.label === 'Overview' ? 'Competitive' : active.label;
  return (
    <>
      <PageHead
        kicker="Play"
        title={title}
        lede={`${data.formatLabel} · Limitless snapshot, not live sync`}
      />
      <nav className="comp-tabs" aria-label="Competitive">
        {COMP_NAV.map((row) => (
          <Link key={row.to} className={row.match(location.pathname) ? 'on' : undefined} to={row.to}>
            {row.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
