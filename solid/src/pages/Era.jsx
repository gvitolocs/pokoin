import { createMemo, createSignal, For, Match, onSettled, Show, Switch, untrack } from 'solid-js';
import { useParams } from '@solidjs/router';
import { fetchExpansions } from '@market/api.js';
import { game, isPokemonGame } from '@market/game.js';
import { TCG_ERA_ORDER, eraFromParam, eraHref, expansionsForEraPage } from '@market/set-logos.js';
import { tcgEraYears } from '@market/tcg-eras.js';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/desk/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';
import SetGuideGrid, { SetGuideSkeleton } from '../components/SetGuideGrid.jsx';

const CRUMBS_TO_ERAS = [
  { name: 'Marketplace', href: '/marketplace' },
  { name: 'Sets', href: '/marketplace/sets' },
];

/** Satellite TCGs do not reuse Pokémon era blocks. */
function SatelliteEras() {
  const site = game();
  document.title = `${site.name} Eras | Pokoin`;
  return (
    <div class="page desk set-guide-page">
      <SeoHead
        title={`${site.name} Eras | Pokoin`}
        description={`${site.name} expansions live under Sets — each TCG keeps its own era catalog.`}
        canonical="/marketplace/eras"
      />
      <SeoCrumbs items={[...CRUMBS_TO_ERAS, { name: 'Eras' }]} />
      <EmptyDesk
        title={`${site.name} eras`}
        lede={`${site.name} does not use Pokémon TCG blocks. Open Sets for this game’s expansions.`}
      >
        <a class="btn" href="/marketplace/sets">Sets</a>
      </EmptyDesk>
    </div>
  );
}

function UnknownEra() {
  document.title = 'Pokémon TCG Eras | Pokoin';
  return (
    <div class="page desk set-guide-page">
      <SeoCrumbs items={[...CRUMBS_TO_ERAS, { name: 'Eras', href: '/marketplace/eras' }]} />
      <EmptyDesk title="Unknown era" lede="Open the set catalog and pick a TCG block.">
        <a class="btn" href="/marketplace/sets">Sets</a>
      </EmptyDesk>
    </div>
  );
}

function EraIndex() {
  document.title = 'Pokémon TCG Eras | Pokoin';
  return (
    <div class="page desk set-guide-page">
      <SeoHead
        title="Pokémon TCG Eras | Pokoin"
        description="Pokémon TCG blocks. JP, EN, and CN of the same generation stay together."
        canonical="/marketplace/eras"
      />
      <SeoCrumbs items={[...CRUMBS_TO_ERAS, { name: 'Eras' }]} />
      <PageHead
        kicker="Catalog"
        title="Eras"
        lede="Pokémon TCG blocks. JP, EN, and CN of the same generation stay together."
      />
      <ol class="era-index">
        <For each={TCG_ERA_ORDER}>
          {(name) => (
            <li>
              <a class="era-link era-index-link" href={eraHref(name)}>
                <strong>{name}</strong>
                <Show when={tcgEraYears(name)}><span>{tcgEraYears(name)}</span></Show>
              </a>
            </li>
          )}
        </For>
      </ol>
    </div>
  );
}

/** One TCG block's setlist: JP / EN / CN expansions of that generation (set-logos.js membership). */
function EraSets(props) {
  const era = untrack(() => props.era);
  const years = tcgEraYears(era);
  const [expansions, setExpansions] = createSignal(null);
  const [error, setError] = createSignal('');
  document.title = `${era} Pokémon TCG Sets | Pokoin`;
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
  const rows = createMemo(() => expansionsForEraPage(expansions() || [], era));

  return (
    <div class="page desk set-guide-page">
      <SeoHead
        title={`${era} Pokémon TCG Sets | Pokoin`}
        description={years ? `${era} Pokémon TCG sets (${years}). English, Japanese, and Chinese expansions in this block.` : `${era} Pokémon TCG sets. English, Japanese, and Chinese expansions in this block.`}
        canonical={eraHref(era)}
      />
      <SeoCrumbs items={[...CRUMBS_TO_ERAS, { name: 'Eras', href: '/marketplace/eras' }, { name: era }]} />
      <PageHead
        kicker="Setlist"
        title={<span class="era-link">{era}</span>}
        lede={years || undefined}
      />
      <p class="result-count">
        <Show when={expansions() != null} fallback="Loading…">
          <strong>{rows().length}</strong> sets
        </Show>
      </p>
      <Alert message={error()} />
      <Show
        when={!(expansions() && !rows().length)}
        fallback={<EmptyDesk title="No sets in this era" lede="The catalog has not listed expansions for this block yet." />}
      >
        <Show when={expansions() != null} fallback={<SetGuideSkeleton />}>
          <SetGuideGrid rows={rows()} />
        </Show>
      </Show>
    </div>
  );
}

/** /marketplace/eras and /marketplace/eras/:eraId (market/src/pages/Era.jsx). */
export default function Era() {
  const params = useParams();
  const pokemon = isPokemonGame();
  const era = () => (params.eraId ? eraFromParam(params.eraId) : '');
  return (
    <Switch>
      <Match when={!pokemon}><SatelliteEras /></Match>
      <Match when={params.eraId && !era()}><UnknownEra /></Match>
      <Match when={!params.eraId}><EraIndex /></Match>
      <Match when={era()} keyed>{(name) => <EraSets era={name} />}</Match>
    </Switch>
  );
}
