import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchExpansions } from '../api.js';
import { ERA_CHIPS, groupExpansions, headingHref } from '../set-logos.js';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';
import SetGuideGrid from '../components/SetGuideGrid.jsx';

export default function Sets() {
  const [expansions, setExpansions] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState('all');

  useEffect(() => {
    document.title = 'Pokémon TCG Set List, Prices & Values | Pokoin';
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
  }, []);

  const grouped = useMemo(
    () => groupExpansions(expansions || [], { query, chip }),
    [expansions, query, chip],
  );
  const shown = grouped.reduce((sum, [, rows]) => sum + rows.length, 0);

  return (
    <div className="page desk set-guide-page">
      <SeoHead
        title="Pokémon TCG Set List, Prices & Values | Pokoin"
        description="Pokémon expansions from the marketplace catalog: English, Japanese, and Chinese sets with card lists and prices."
        canonical="/marketplace/sets"
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Sets' },
      ]} />
      <PageHead
        kicker="Catalog"
        title="Sets"
        lede="English, Japanese, and Chinese expansions. Open a set for the card list."
      />
      <div className="set-guide-filters" role="group" aria-label="Set era">
        {ERA_CHIPS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={chip === item.id}
            className={chip === item.id ? 'on' : ''}
            onClick={() => setChip(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <form className="shop-toolbar" onSubmit={(event) => event.preventDefault()}>
        <p className="result-count">
          {expansions == null ? 'Loading…' : <><strong>{shown}</strong> sets</>}
        </p>
        <input
          className="shop-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter sets…"
          aria-label="Filter sets"
        />
      </form>
      <Alert>{error}</Alert>
      {expansions && !shown ? (
        <EmptyDesk title="No sets match" lede="Clear the filter or open a set from a card desk." />
      ) : expansions == null ? (
        <div className="set-guide-grid" aria-hidden="true">
          {Array.from({ length: 8 }, (_, index) => (
            <div className="set-guide-card is-skeleton" key={index} />
          ))}
        </div>
      ) : (
        grouped.map(([era, rows]) => (
          <section className="set-guide-era" key={era}>
            <h2>
              <Link className="era-link" to={headingHref(era)}>{era}</Link>
            </h2>
            <SetGuideGrid rows={rows} />
          </section>
        ))
      )}
    </div>
  );
}
