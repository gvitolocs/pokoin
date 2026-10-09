import { createMemo, createSignal, For, Match, onSettled, Repeat, Show, Switch, untrack } from 'solid-js';
import { useParams } from '@solidjs/router';
import { fetchExactNameCards } from '@market/api.js';
import { pokedexNumber } from '@market/pokedex.js';
import { pokemonGenerations, pokemonHref, speciesFromSlug } from '@market/pokemon-hubs.js';
import { filterSearchCards } from '@market/search-filters.js';
import { pokemonSeoTitle } from '@market/seo.js';
import CardSelectGrid from '../components/CardSelectGrid.jsx';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/desk/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';

const dex = (n) => `#${String(n).padStart(4, '0')}`;

function PokemonIndex(props) {
  const gens = pokemonGenerations();
  return (
    <div class="page desk hub-page">
      <SeoHead
        title={pokemonSeoTitle('')}
        description="Browse Pokémon TCG cards by species, from Bulbasaur to Pecharunt. Open a Pokémon to compare printings, sets, languages, and listings."
        canonical={`/marketplace/${props.lang}/pokemon`}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Pokémon' },
      ]} />
      <PageHead kicker="Catalog" title="Pokémon" />
      <For each={gens}>
        {(gen) => (
          <section class="hub-index-block">
            <h2>Generation {gen.id} · {gen.title}</h2>
            <ol class="hub-index">
              <For each={gen.rows}>
                {(row) => (
                  <li>
                    <a href={pokemonHref(row.slug, props.lang)}>
                      <span class="hub-dex">{dex(row.n)}</span>
                      {row.name}
                    </a>
                  </li>
                )}
              </For>
            </ol>
          </section>
        )}
      </For>
    </div>
  );
}

/** Every printing of one species (exact-name search, kept to that National Dex number), in Pokédex order. */
function SpeciesCards(props) {
  const species = untrack(() => props.species);
  const lang = untrack(() => props.lang);
  // Plain rows (one load): the Pokédex sort reads many fields of every card,
  // which a store would track one by one.
  const [cards, setCards] = createSignal(null);
  const [error, setError] = createSignal('');
  const ready = () => cards() != null;
  let disposed = false;
  fetchExactNameCards(species.name, { lang, limit: 96 })
    .then((rows) => {
      if (disposed) return;
      setCards(() => rows.filter((card) => pokedexNumber(card) === species.n));
      setError('');
    })
    .catch((err) => {
      if (!disposed) setError(err.message || 'Pokémon cards failed.');
    });
  onSettled(() => () => {
    disposed = true;
  });
  const shown = createMemo(() => filterSearchCards(cards() || [], { type: 'singles', sort: 'pokedex' }));

  return (
    <div class="page desk hub-page">
      <SeoHead
        title={pokemonSeoTitle(species.name)}
        description={`Browse every ${species.name} Pokémon TCG card, from Base Set to the latest expansions. Compare versions, languages, prices and cards currently available for sale.`}
        canonical={pokemonHref(species.slug, lang)}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Pokémon', href: `/marketplace/${lang}/pokemon` },
        { name: species.name },
      ]} />
      <PageHead kicker={dex(species.n)} title={species.name} />
      <p class="result-count">
        <Show when={ready()} fallback="Loading…">
          <strong>{shown().length}</strong> {species.name} cards
        </Show>
      </p>
      <Alert message={error()} />
      <Show
        when={!(ready() && !shown().length)}
        fallback={<EmptyDesk title={`No ${species.name} cards yet`} lede="The catalog has not listed leftover printings for this species." />}
      >
        <CardSelectGrid class="grid" cards={ready() ? shown() : []}>
          <Show when={ready()} fallback={<Repeat count={12}>{() => <SkeletonTile />}</Repeat>}>
            <For each={shown()} keyed={(card) => card.id}>
              {(card, index) => <CardTile card={card()} rank={index()} />}
            </For>
          </Show>
        </CardSelectGrid>
      </Show>
    </div>
  );
}

/** /marketplace/:lang/pokemon(/:slug) (market/src/pages/PokemonHub.jsx). */
export default function PokemonHub() {
  const params = useParams();
  const lang = () => params.lang || 'en';
  const species = () => (params.slug ? speciesFromSlug(params.slug) : null);
  return (
    <Switch>
      <Match when={!params.slug}><PokemonIndex lang={lang()} /></Match>
      <Match when={!species()}>
        <div class="page desk hub-page">
          <SeoCrumbs items={[
            { name: 'Marketplace', href: '/marketplace' },
            { name: 'Pokémon', href: `/marketplace/${lang()}/pokemon` },
          ]} />
          <EmptyDesk title="Unknown Pokémon" lede="Open the species index and pick a National Dex entry.">
            <a class="btn" href={`/marketplace/${lang()}/pokemon`}>Pokémon</a>
          </EmptyDesk>
        </div>
      </Match>
      <Match when={species() && `${lang()}:${species().slug}`} keyed>
        {(key) => (
          <SpeciesCards
            species={speciesFromSlug(key.slice(key.indexOf(':') + 1))}
            lang={key.slice(0, key.indexOf(':'))}
          />
        )}
      </Match>
    </Switch>
  );
}
