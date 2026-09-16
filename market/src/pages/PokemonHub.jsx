import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchExactNameCards } from '../api.js';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';
import { pokedexNumber } from '../pokedex.js';
import {
  pokemonGenerations,
  pokemonHref,
  speciesFromSlug,
} from '../pokemon-hubs.js';
import { filterSearchCards } from '../search-filters.js';
import { pokemonSeoTitle } from '../seo.js';

function PokemonIndex({ lang }) {
  const gens = pokemonGenerations();
  const title = pokemonSeoTitle('');
  return (
    <div className="page desk hub-page">
      <SeoHead
        title={title}
        description="Browse Pokémon TCG cards by species, from Bulbasaur to Pecharunt. Open a Pokémon to compare printings, sets, languages, and listings."
        canonical={`/marketplace/${lang}/pokemon`}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Pokémon' },
      ]} />
      <PageHead
        kicker="Catalog"
        title="Pokémon"
      />
      {gens.map((gen) => (
        <section className="hub-index-block" key={gen.id}>
          <h2>Generation {gen.id} · {gen.title}</h2>
          <ol className="hub-index">
            {gen.rows.map((row) => (
              <li key={row.slug}>
                <Link to={pokemonHref(row.slug, lang)}>
                  <span className="hub-dex">#{String(row.n).padStart(4, '0')}</span>
                  {row.name}
                </Link>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

export default function PokemonHub() {
  const { lang = 'en', slug } = useParams();
  const species = slug ? speciesFromSlug(slug) : null;
  const [cards, setCards] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!species) {
      setCards(null);
      setError('');
      return undefined;
    }
    let cancelled = false;
    setCards(null);
    fetchExactNameCards(species.name, { lang, limit: 96 })
      .then((rows) => {
        if (cancelled) return;
        setCards(rows.filter((card) => pokedexNumber(card) === species.n));
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Pokémon cards failed.');
      });
    return () => {
      cancelled = true;
    };
  }, [species?.slug, species?.name, species?.n, lang]);

  const shown = useMemo(
    () => filterSearchCards(cards || [], { type: 'singles', sort: 'pokedex' }),
    [cards],
  );

  if (!slug) {
    return <PokemonIndex lang={lang} />;
  }
  if (!species) {
    return (
      <div className="page desk hub-page">
        <SeoCrumbs items={[
          { name: 'Marketplace', href: '/marketplace' },
          { name: 'Pokémon', href: `/marketplace/${lang}/pokemon` },
        ]} />
        <EmptyDesk title="Unknown Pokémon" lede="Open the species index and pick a National Dex entry.">
          <Link className="btn" to={`/marketplace/${lang}/pokemon`}>Pokémon</Link>
        </EmptyDesk>
      </div>
    );
  }

  const title = pokemonSeoTitle(species.name);
  const description = `Browse every ${species.name} Pokémon TCG card, from Base Set to the latest expansions. Compare versions, languages, prices and cards currently available for sale.`;
  return (
    <div className="page desk hub-page">
      <SeoHead
        title={title}
        description={description}
        canonical={pokemonHref(species.slug, lang)}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Pokémon', href: `/marketplace/${lang}/pokemon` },
        { name: species.name },
      ]} />
      <PageHead
        kicker={`#${String(species.n).padStart(4, '0')}`}
        title={species.name}
      />
      <p className="result-count">
        {cards == null ? 'Loading…' : <><strong>{shown.length}</strong> {species.name} cards</>}
      </p>
      <Alert>{error}</Alert>
      {cards && !shown.length ? (
        <EmptyDesk title={`No ${species.name} cards yet`} lede="The catalog has not listed leftover printings for this species." />
      ) : (
        <div className="grid">
          {cards == null
            ? Array.from({ length: 12 }, (_, index) => <SkeletonTile key={index} />)
            : shown.map((card, index) => (
              <CardTile key={card.id} card={card} rank={index} />
            ))}
        </div>
      )}
    </div>
  );
}
