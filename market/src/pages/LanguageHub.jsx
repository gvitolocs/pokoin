import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchExpansions } from '../api.js';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';
import SetGuideGrid from '../components/SetGuideGrid.jsx';
import { printBucket } from '../locale.js';
import { LANGUAGE_HUBS, languageHref } from '../seo.js';

function languageMatches(row, hub) {
  const bucket = printBucket(row.nationality);
  if (hub.nationality === 'western') {
    return bucket === 'western' || bucket === 'american' || bucket === 'european';
  }
  return bucket === hub.nationality;
}

function LanguageIndex({ lang }) {
  return (
    <div className="page desk hub-page">
      <SeoHead
        title="Pokémon Card Languages | Pokoin"
        description="Browse Pokémon TCG expansions by print language: English, Japanese, Korean, and Chinese."
        canonical={`/marketplace/${lang}/languages`}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Languages' },
      ]} />
      <PageHead
        kicker="Catalog"
        title="Languages"
      />
      <ol className="hub-index hub-index-wide">
        {LANGUAGE_HUBS.map((row) => (
          <li key={row.slug}>
            <Link to={languageHref(row.slug, lang)}>{row.name} print</Link>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function LanguageHub() {
  const { lang = 'en', slug } = useParams();
  const hub = LANGUAGE_HUBS.find((row) => row.slug === String(slug || '').toLowerCase()) || null;
  const [expansions, setExpansions] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!hub) {
      setExpansions(null);
      return undefined;
    }
    let cancelled = false;
    fetchExpansions({ limit: 2000 })
      .then((data) => {
        if (!cancelled) setExpansions(data.expansions || data.sets || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Sets failed.');
      });
    return () => {
      cancelled = true;
    };
  }, [hub?.slug]);

  const rows = useMemo(
    () => (hub ? (expansions || []).filter((row) => languageMatches(row, hub)) : []),
    [expansions, hub],
  );

  if (!slug) {
    return <LanguageIndex lang={lang} />;
  }
  if (!hub) {
    return (
      <div className="page desk hub-page">
        <EmptyDesk title="Unknown language" lede="Open the language index.">
          <Link className="btn" to={`/marketplace/${lang}/languages`}>Languages</Link>
        </EmptyDesk>
      </div>
    );
  }

  const title = `${hub.name} Pokémon Cards | Pokoin`;
  const description = `${hub.name} Pokémon TCG expansions and printings on Pokoin.`;
  return (
    <div className="page desk set-guide-page hub-page">
      <SeoHead
        title={title}
        description={description}
        canonical={languageHref(hub.slug, lang)}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Languages', href: `/marketplace/${lang}/languages` },
        { name: hub.name },
      ]} />
      <PageHead kicker="Print language" title={`${hub.name} print`} />
      <p className="result-count">
        {expansions == null ? 'Loading…' : <><strong>{rows.length}</strong> sets</>}
      </p>
      <Alert>{error}</Alert>
      {expansions && !rows.length ? (
        <EmptyDesk title="No sets for this print language" lede="Try another language hub." />
      ) : expansions == null ? (
        <div className="set-guide-grid" aria-hidden="true">
          {Array.from({ length: 8 }, (_, index) => (
            <div className="set-guide-card is-skeleton" key={index} />
          ))}
        </div>
      ) : (
        <SetGuideGrid rows={rows} />
      )}
    </div>
  );
}
