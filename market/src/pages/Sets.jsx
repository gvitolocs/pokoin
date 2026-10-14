import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchExpansions } from '../api.js';
import { satelliteGroups } from '../browse-hubs.js';
import { game, isPokemonGame } from '../game.js';
import { ERA_CHIPS, groupExpansions, headingHref } from '../set-logos.js';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';
import SetGuideGrid from '../components/SetGuideGrid.jsx';

export default function Sets() {
  const site = game();
  const pokemon = isPokemonGame();
  const [expansions, setExpansions] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState('all');

  useEffect(() => {
    document.title = pokemon
      ? 'Pokémon TCG Set List, Prices & Values | Pokoin'
      : `${site.name} Sets | Pokoin`;
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
  }, [pokemon, site.name]);

  const grouped = useMemo(
    () => (pokemon
      ? groupExpansions(expansions || [], { query, chip })
      : satelliteGroups(expansions, query)),
    [expansions, query, chip, pokemon],
  );
  const shown = grouped.reduce((sum, [, rows]) => sum + rows.length, 0);
  const title = pokemon
    ? 'Pokémon TCG Set List, Prices & Values | Pokoin'
    : `${site.name} Sets | Pokoin`;
  const description = pokemon
    ? 'Pokémon expansions from the marketplace catalog: English, Japanese, and Chinese sets with card lists and prices.'
    : `${site.name} expansions from the marketplace catalog with card lists and prices.`;

  return (
    <div className="page desk set-guide-page">
      <SeoHead
        title={title}
        description={description}
        canonical="/marketplace/sets"
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Sets' },
      ]} />
      <PageHead
        kicker="Catalog"
        title="Sets"
        lede={pokemon
          ? 'English, Japanese, and Chinese expansions. Open a set for the card list.'
          : `${site.name} expansions. Open a set for the card list.`}
      />
      {pokemon ? (
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
      ) : null}
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
              {pokemon ? (
                <Link className="era-link" to={headingHref(era)}>{era}</Link>
              ) : (
                <span>{era}</span>
              )}
            </h2>
            <SetGuideGrid rows={rows} />
          </section>
        ))
      )}
    </div>
  );
}
