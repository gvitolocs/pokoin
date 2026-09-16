import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchExpansions } from '../api.js';
import SetGuideGrid from '../components/SetGuideGrid.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';
import {
  TCG_ERA_ORDER,
  eraFromParam,
  eraHref,
  expansionsForEraPage,
} from '../set-logos.js';
import { tcgEraYears } from '../tcg-eras.js';

export default function Era() {
  const { eraId } = useParams();
  const era = eraId ? eraFromParam(eraId) : '';
  const [expansions, setExpansions] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = era ? `${era} Pokémon TCG Sets | Pokoin` : 'Pokémon TCG Eras | Pokoin';
    if (!era) return undefined;
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
  }, [era]);

  const rows = useMemo(
    () => (era ? expansionsForEraPage(expansions || [], era) : []),
    [expansions, era],
  );
  const years = era ? tcgEraYears(era) : '';

  if (eraId && !era) {
    return (
      <div className="page desk set-guide-page">
        <SeoCrumbs items={[
          { name: 'Marketplace', href: '/marketplace' },
          { name: 'Sets', href: '/marketplace/sets' },
          { name: 'Eras', href: '/marketplace/eras' },
        ]} />
        <EmptyDesk title="Unknown era" lede="Open the set catalog and pick a TCG block.">
          <Link className="btn" to="/marketplace/sets">Sets</Link>
        </EmptyDesk>
      </div>
    );
  }

  if (!eraId) {
    return (
      <div className="page desk set-guide-page">
        <SeoHead
          title="Pokémon TCG Eras | Pokoin"
          description="Pokémon TCG blocks. JP, EN, and CN of the same generation stay together."
          canonical="/marketplace/eras"
        />
        <SeoCrumbs items={[
          { name: 'Marketplace', href: '/marketplace' },
          { name: 'Sets', href: '/marketplace/sets' },
          { name: 'Eras' },
        ]} />
        <PageHead
          kicker="Catalog"
          title="Eras"
          lede="Pokémon TCG blocks. JP, EN, and CN of the same generation stay together."
        />
        <ol className="era-index">
          {TCG_ERA_ORDER.map((name) => (
            <li key={name}>
              <Link className="era-link era-index-link" to={eraHref(name)}>
                <strong>{name}</strong>
                {tcgEraYears(name) ? <span>{tcgEraYears(name)}</span> : null}
              </Link>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return (
    <div className="page desk set-guide-page">
      <SeoHead
        title={`${era} Pokémon TCG Sets | Pokoin`}
        description={years ? `${era} Pokémon TCG sets (${years}). English, Japanese, and Chinese expansions in this block.` : `${era} Pokémon TCG sets. English, Japanese, and Chinese expansions in this block.`}
        canonical={eraHref(era)}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Sets', href: '/marketplace/sets' },
        { name: 'Eras', href: '/marketplace/eras' },
        { name: era },
      ]} />
      <PageHead
        kicker="Setlist"
        title={<span className="era-link">{era}</span>}
        lede={years || undefined}
      />
      <p className="result-count">
        {expansions == null ? 'Loading…' : <><strong>{rows.length}</strong> sets</>}
      </p>
      <Alert>{error}</Alert>
      {expansions && !rows.length ? (
        <EmptyDesk title="No sets in this era" lede="The catalog has not listed expansions for this block yet." />
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
