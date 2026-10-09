import { Link } from 'react-router-dom';
import { catalogLinks, catalogMenuLinks } from '../catalog-links.js';

export { catalogLinks };

export default function CatalogMenu({ lang = 'en', onNavigate }) {
  const extras = catalogMenuLinks(lang);
  return (
    <details className="foot-catalog">
      <summary>Catalog</summary>
      <nav aria-label="Catalog">
        {extras.map((row) => (
          <Link key={row.to} to={row.to} onClick={onNavigate}>{row.label}</Link>
        ))}
        <a href="/news">News</a>
      </nav>
    </details>
  );
}
