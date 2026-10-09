import { createMemo, createSignal, For, onSettled, Show } from 'solid-js';
import { fetchExpansions } from '@market/api.js';
import { satelliteGroups } from '@market/browse-hubs.js';
import { game, isPokemonGame } from '@market/game.js';
import { ERA_CHIPS, groupExpansions, headingHref } from '@market/set-logos.js';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/desk/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';
import SetGuideGrid, { SetGuideSkeleton } from '../components/SetGuideGrid.jsx';

/**
 * /marketplace/sets (market/src/pages/Sets.jsx): every expansion grouped by
 * TCG era (Pokémon) or one A → Z list (satellite games), with the era chips
 * and a name filter. Era membership and in-era order are set-logos.js rules.
 */
export default function Sets() {
  const site = game();
  const pokemon = isPokemonGame();
  const [expansions, setExpansions] = createSignal(null);
  const [error, setError] = createSignal('');
  const [query, setQuery] = createSignal('');
  const [chip, setChip] = createSignal('all');
  const title = pokemon
    ? 'Pokémon TCG Set List, Prices & Values | Pokoin'
    : `${site.name} Sets | Pokoin`;
  const description = pokemon
    ? 'Pokémon expansions from the marketplace catalog: English, Japanese, and Chinese sets with card lists and prices.'
    : `${site.name} expansions from the marketplace catalog with card lists and prices.`;

  document.title = title;
  let disposed = false;
  fetchExpansions({ limit: 2000 })
    .then((data) => {
      if (!disposed) setExpansions(() => data.expansions || data.sets || []);
    })
    .catch((err) => {
      if (!disposed) setError(err.message || 'Sets failed.');
    });
  onSettled(() => () => {
    disposed = true;
  });

  const grouped = createMemo(() => (pokemon
    ? groupExpansions(expansions() || [], { query: query(), chip: chip() })
    : satelliteGroups(expansions(), query())));
  const shown = () => grouped().reduce((sum, [, rows]) => sum + rows.length, 0);

  return (
    <div class="page desk set-guide-page">
      <SeoHead title={title} description={description} canonical="/marketplace/sets" />
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
      <Show when={pokemon}>
        <div class="set-guide-filters" role="group" aria-label="Set era">
          <For each={ERA_CHIPS}>
            {(item) => (
              <button
                type="button"
                aria-pressed={chip() === item.id ? 'true' : 'false'}
                class={chip() === item.id ? 'on' : ''}
                onClick={() => setChip(item.id)}
              >
                {item.label}
              </button>
            )}
          </For>
        </div>
      </Show>
      <form class="shop-toolbar" onSubmit={(event) => event.preventDefault()}>
        <p class="result-count">
          <Show when={expansions() != null} fallback="Loading…">
            <strong>{shown()}</strong> sets
          </Show>
        </p>
        <input
          class="shop-search"
          type="search"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder="Filter sets…"
          aria-label="Filter sets"
        />
      </form>
      <Alert message={error()} />
      <Show
        when={!(expansions() && !shown())}
        fallback={<EmptyDesk title="No sets match" lede="Clear the filter or open a set from a card desk." />}
      >
        <Show when={expansions() != null} fallback={<SetGuideSkeleton />}>
          <For each={grouped()} keyed={([era]) => era}>
            {(group) => (
              <section class="set-guide-era">
                <h2>
                  <Show when={pokemon} fallback={<span>{group()[0]}</span>}>
                    <a class="era-link" href={headingHref(group()[0])}>{group()[0]}</a>
                  </Show>
                </h2>
                <SetGuideGrid rows={group()[1]} />
              </section>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}
