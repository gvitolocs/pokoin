import { createSignal, createStore, For, onSettled, reconcile, Show } from 'solid-js';
import { clearWatchlist, hydrateWatchlist } from '@market/api.js';
import CardSelectGrid from '../components/CardSelectGrid.jsx';
import CardTile from '../components/CardTile.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';

/**
 * /marketplace/watchlist and /favorites (market/src/pages/Watchlist.jsx):
 * the starred card ids saved in this browser, hydrated to tiles.
 */
export default function Watchlist() {
  const [list, setList] = createStore({ cards: [] });
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal('');
  let disposed = false;

  function putCards(next) {
    setList((draft) => {
      reconcile(next, 'id')(draft.cards);
    });
  }

  document.title = 'Watchlist · Pokoin';
  hydrateWatchlist()
    .then((rows) => {
      if (disposed) return;
      putCards(rows);
      setReady(true);
    })
    .catch((err) => {
      if (!disposed) setError(err.message || 'Watchlist failed.');
    });
  onSettled(() => () => {
    disposed = true;
  });

  return (
    <div class="page desk">
      <PageHead kicker="Account" title="Watchlist" lede="Saved on this browser until you sign in. Not a server list.">
        <Show when={list.cards.length}>
          <button
            class="btn ghost"
            type="button"
            onClick={() => {
              clearWatchlist();
              putCards([]);
              setReady(true);
            }}
          >
            Clear
          </button>
        </Show>
        <a class="btn ghost" href="/marketplace">Shop</a>
      </PageHead>
      <Alert message={error()} />
      <Show when={!ready()}><div class="skeleton-line" /></Show>
      <Show when={ready() && !list.cards.length}>
        <EmptyDesk title="Nothing watched" lede="Open a card and tap the star.">
          <a class="btn" href="/marketplace">Browse marketplace</a>
        </EmptyDesk>
      </Show>
      <CardSelectGrid class="grid" cards={list.cards}>
        <For each={list.cards}>
          {(card, index) => <CardTile card={card} rank={index()} />}
        </For>
      </CardSelectGrid>
    </div>
  );
}
