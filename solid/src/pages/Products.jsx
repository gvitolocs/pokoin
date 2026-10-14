import { createSignal, createStore, For, onSettled, reconcile, Repeat, Show, untrack } from 'solid-js';
import { useParams } from '@solidjs/router';
import { PRODUCT_AISLES, aisleEmptyLede, loadAisle, productAisle } from '@market/product-aisles.js';
import CardSelectGrid from '../components/CardSelectGrid.jsx';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';

const AISLES = Object.entries(PRODUCT_AISLES);

/** One aisle's results; remounted per kind so a slow answer never lands on another aisle. */
function Aisle(props) {
  const kind = untrack(() => props.kind);
  const spec = productAisle(kind);
  const [list, setList] = createStore({ cards: [] });
  const [hasMore, setHasMore] = createSignal(false);
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(true);
  // Plain mirror for Load more: the next offset is read before the store flushes.
  let cardsNow = [];
  let disposed = false;

  function putCards(next) {
    cardsNow = next;
    setList((draft) => {
      reconcile(next, 'id')(draft.cards);
    });
  }

  document.title = `${spec.title} · Pokoin`;
  loadAisle(spec, { limit: 48 })
    .then((data) => {
      if (disposed) return;
      putCards(data.cards || []);
      setHasMore(Boolean(data.hasMore));
      setError('');
    })
    .catch((err) => {
      if (!disposed) setError(err.message || 'Product search failed.');
    })
    .finally(() => {
      if (!disposed) setLoading(false);
    });
  onSettled(() => () => {
    disposed = true;
  });

  async function loadMore() {
    if (spec.mode === 'graded') return;
    const data = await loadAisle(spec, { offset: cardsNow.length, limit: 48 });
    if (disposed) return;
    putCards([...cardsNow, ...(data.cards || [])]);
    setHasMore(Boolean(data.hasMore));
  }

  return (
    <div class="page desk">
      <PageHead kicker="Products" title={spec.title} lede={spec.lede} />
      <nav class="comp-tabs" aria-label="Product types">
        <For each={AISLES}>
          {([id, row]) => (
            <a class={kind === id ? 'on' : undefined} href={`/product/${id}`}>{row.title}</a>
          )}
        </For>
      </nav>
      <div class="shop-toolbar">
        <p class="result-count">
          <Show when={!loading()} fallback="Loading…">
            <Show
              when={list.cards.length}
              fallback={kind === 'graded' ? 'No graded cards listed.' : 'No products in that search.'}
            >
              <strong>{list.cards.length.toLocaleString('en-US')}{hasMore() ? '+' : ''}</strong> {spec.unit}
            </Show>
          </Show>
        </p>
      </div>
      <Alert message={error()} />
      <Show
        when={loading() || list.cards.length || error()}
        fallback={(
          <EmptyDesk title="Nothing in this aisle" lede={aisleEmptyLede(kind)}>
            <a class="btn" href="/marketplace">Shop</a>
          </EmptyDesk>
        )}
      >
        <CardSelectGrid class="grid" cards={loading() ? [] : list.cards}>
          <Show when={!loading()} fallback={<Repeat count={12}>{() => <SkeletonTile />}</Repeat>}>
            <For each={list.cards}>
              {(card, index) => <CardTile card={card} rank={index()} />}
            </For>
          </Show>
        </CardSelectGrid>
      </Show>
      <Show when={hasMore()}>
        <button class="more" type="button" onClick={loadMore}>Load more</button>
      </Show>
    </div>
  );
}

/** /product/:kind (market/src/pages/Products.jsx): sealed, graded, jumbo and NFT aisles. */
export default function Products() {
  const params = useParams();
  return (
    <Show when={params.kind || 'box'} keyed>
      {(kind) => <Aisle kind={kind} />}
    </Show>
  );
}
