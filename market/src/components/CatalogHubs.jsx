import { Link } from 'react-router-dom';

export function catalogLinks(lang = 'en') {
  const language = String(lang || 'en').toLowerCase() || 'en';
  return [
    { to: `/marketplace/${language}/pokemon`, label: 'Pokémon' },
    { to: '/marketplace/sets', label: 'Sets' },
    { to: '/marketplace/eras', label: 'Eras' },
    { to: `/marketplace/${language}/artists`, label: 'Artists' },
    { to: `/marketplace/${language}/rarities`, label: 'Rarities' },
    { to: `/marketplace/${language}/languages`, label: 'Languages' },
    { to: `/marketplace/${language}/guides`, label: 'Guides' },
  ];
}

const EXTRA = new Set(['Eras', 'Rarities', 'Languages', 'Guides']);

export default function CatalogMenu({ lang = 'en', variant = 'foot', onNavigate }) {
  const extras = catalogLinks(lang).filter((row) => EXTRA.has(row.label));
  return (
    <details className={variant === 'mobile' ? 'mobile-catalog' : 'foot-catalog'}>
      <summary>Catalog</summary>
      <nav aria-label="Catalog">
        {extras.map((row) => (
          <Link key={row.to} to={row.to} onClick={onNavigate}>{row.label}</Link>
        ))}
      </nav>
    </details>
  );
}
