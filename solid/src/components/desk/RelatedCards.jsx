import { createEffect, createMemo, createStore, For, reconcile, Show, untrack } from 'solid-js';
import { overlayCatalogTilePrices } from '@market/api.js';
import CardSelectGrid from '../CardSelectGrid.jsx';
import CardTile from '../CardTile.jsx';

function idsOf(rows) {
  return (rows || []).map((row) => String(row?.id || '')).join('|');
}

/** Store rows are copies: reconcile writes into them, never into cache objects. */
function copies(rows) {
  return (rows || []).slice(0, 12).map((row) => ({ ...row }));
}

/**
 * Related cards panel (market/src/components/RelatedCards.jsx). The tiles live
 * in a store reconciled by id: a new related list with the same ids keeps every
 * tile, and the price overlay only patches the price fields that changed.
 */
export default function RelatedCards(props) {
  // Ids are the related set: a new array with the same ids is the same list.
  const rows = createMemo(
    () => (props.related || []).filter((row) => row?.id && String(row.id) !== String(props.card?.id || '')),
    { equals: (a, b) => idsOf(a) === idsOf(b) },
  );
  const [tiles, setTiles] = createStore({ list: copies(untrack(rows)) });

  createEffect(rows, (list) => {
    setTiles((draft) => {
      reconcile(copies(list), 'id')(draft.list);
    });
    if (!list.length) return undefined;
    let live = true;
    overlayCatalogTilePrices(list).then((next) => {
      if (!live) return;
      setTiles((draft) => {
        reconcile(copies(next), 'id')(draft.list);
      });
    }).catch(() => {});
    return () => {
      live = false;
    };
  });

  // Every tile starts loading with the panel, behind the desk scan.
  const grid = () => (
    <For each={tiles.list}>
      {(row, index) => <CardTile card={row} rank={index()} eagerLimit={12} artPriority="low" />}
    </For>
  );

  return (
    <Show when={tiles.list.length}>
      <section class="panel related-panel">
        <header class="panel-head">
          <h2>Related cards</h2>
          <Show when={props.speciesHref && props.speciesName}>
            <a href={props.speciesHref}>All {props.speciesName}</a>
          </Show>
        </header>
        <Show
          when={props.embedded}
          fallback={<CardSelectGrid class="grid related-grid">{grid()}</CardSelectGrid>}
        >
          <div class="grid related-grid">{grid()}</div>
        </Show>
      </section>
    </Show>
  );
}
