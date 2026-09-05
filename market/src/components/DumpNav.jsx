import { Link, useLocation } from 'react-router-dom';

const LINKS = [
  { to: '/marketplace/explore', label: 'Explore', match: (path) => path.startsWith('/marketplace/explore') },
  { to: '/marketplace/portfolio', label: 'Portfolio', match: (path) => path.startsWith('/marketplace/portfolio') },
];

export default function DumpNav() {
  const location = useLocation();
  return (
    <nav className="comp-tabs" aria-label="Market holdings">
      {LINKS.map((row) => (
        <Link key={row.to} className={row.match(location.pathname) ? 'on' : undefined} to={row.to}>
          {row.label}
        </Link>
      ))}
    </nav>
  );
}
