import { Link } from 'react-router-dom';

export default function SeoCrumbs({ items = [] }) {
  const crumbs = (items || []).filter((item) => item && item.name);
  if (!crumbs.length) {
    return null;
  }
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {crumbs.map((item, index) => {
        const last = index === crumbs.length - 1;
        return (
          <span key={`${item.name}-${index}`}>
            {index ? <span className="sep">/</span> : null}
            {!last && item.href ? (
              <Link to={item.href}>{item.name}</Link>
            ) : (
              <span className={last ? 'here' : undefined}>{item.name}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
