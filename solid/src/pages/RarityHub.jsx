import { createSignal, createStore, For, Match, onSettled, reconcile, Repeat, Show, Switch, untrack } from 'solid-js';
import { useParams } from '@solidjs/router';
import { fetchSearch } from '@market/api.js';
import { rarityMatches } from '@market/browse-hubs.js';
import { RARITY_HUBS, rarityFromSlug, rarityHref } from '@market/seo.js';
import CardSelectGrid from '../components/CardSelectGrid.jsx';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/desk/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';

function RarityIndex(props) {
  return (
    <div class="page desk hub-page">
      <SeoHead
        title="Pokémon Card Rarities | Pokoin"
        description="Browse Pokémon TCG cards by rarity: Common, Illustration Rare, Special Illustration Rare, Full-Art, Promo, and more."
        canonical={`/marketplace/${props.lang}/rarities`}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Rarities' },
      ]} />
      <PageHead kicker="Catalog" title="Rarities" />
      <ol class="hub-index hub-index-wide">
        <For each={RARITY_HUBS}>
          {(row) => (
            <li>
              <a href={rarityHref(row.slug, props.lang)}>{row.name}</a>
            </li>
          )}
        </For>
      </ol>
    </div>
  );
}

/** One rarity's printings: a card search for the rarity name, kept to rows of that rarity. */
function RarityCards(props) {
  const hub = untrack(() => props.hub);
  const lang = untrack(() => props.lang);
  const [list, setList] = createStore({ cards: [] });
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal('');
  let disposed = false;
  fetchSearch({ query: hub.name, limit: 48, lang, productType: 'card' })
    .then((data) => {
      if (disposed) return;
      setList((draft) => {
        reconcile((data.cards || []).filter((card) => rarityMatches(card, hub)), 'id')(draft.cards);
      });
      setReady(true);
      setError('');
    })
    .catch((err) => {
      if (!disposed) setError(err.message || 'Rarity cards failed.');
    });
  onSettled(() => () => {
    disposed = true;
  });

  return (
    <div class="page desk hub-page">
      <SeoHead
        title={`${hub.name} Pokémon Cards | Pokoin`}
        description={`${hub.name} Pokémon TCG printings on Pokoin. Compare sets, languages, and listings.`}
        canonical={rarityHref(hub.slug, lang)}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Rarities', href: `/marketplace/${lang}/rarities` },
        { name: hub.name },
      ]} />
      <PageHead kicker="Rarity" title={hub.name} />
      <p class="result-count">
        <Show when={ready()} fallback="Loading…">
          <strong>{list.cards.length}</strong> cards
        </Show>
      </p>
      <Alert message={error()} />
      <Show
        when={!(ready() && !list.cards.length)}
        fallback={<EmptyDesk title="No cards in this rarity" lede="Try another rarity or open a set desk." />}
      >
        <CardSelectGrid class="grid" cards={ready() ? list.cards : []}>
          <Show when={ready()} fallback={<Repeat count={12}>{() => <SkeletonTile />}</Repeat>}>
            <For each={list.cards}>
              {(card, index) => <CardTile card={card} rank={index()} />}
            </For>
          </Show>
        </CardSelectGrid>
      </Show>
    </div>
  );
}

/** /marketplace/:lang/rarities(/:slug) (market/src/pages/RarityHub.jsx). */
export default function RarityHub() {
  const params = useParams();
  const lang = () => params.lang || 'en';
  const hub = () => (params.slug ? rarityFromSlug(params.slug) : null);
  return (
    <Switch>
      <Match when={!params.slug}><RarityIndex lang={lang()} /></Match>
      <Match when={!hub()}>
        <div class="page desk hub-page">
          <EmptyDesk title="Unknown rarity" lede="Open the rarity index.">
            <a class="btn" href={`/marketplace/${lang()}/rarities`}>Rarities</a>
          </EmptyDesk>
        </div>
      </Match>
      <Match when={hub() && `${lang()}:${hub().slug}`} keyed>
        {(key) => <RarityCards hub={rarityFromSlug(key.slice(key.indexOf(':') + 1))} lang={key.slice(0, key.indexOf(':'))} />}
      </Match>
    </Switch>
  );
}
