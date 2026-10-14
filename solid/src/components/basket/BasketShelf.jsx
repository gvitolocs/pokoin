// Cart rails in Amazon's layout:
// paged carousels, product cards with "Add to cart", the recently-viewed
// column and the Your Items tabs.

import { createSignal, For, Match, onSettled, Show, Switch, untrack } from 'solid-js';
import {
  cardHref,
  fetchListings,
  imageSrc,
  postWatchlist,
  readWatchlistIds,
  rememberCardId,
  toggleWatchlist,
} from '@market/api.js';
import { listingStub, offerStub, tileStub } from '@market/basket-format.js';
import { cartImageFor } from '@market/cart-image.js';
import { carouselPage } from '@market/cart-model.js';
import { pickCartOffer } from '@market/cart-offer.js';
import { cartItemFromOffer } from '@market/cart-rows.js';
import { displayName, printingIdentity } from '@market/identity.js';
import { homepageDerivativeUrl } from '@market/image-urls.js';
import {
  conditionChipSrc,
  conditionShort,
  conditionTone,
  listingLanguageFlag,
  publicShopSellerLabel,
} from '@market/listing-meta.js';
import { tilePricePkn } from '@market/pkn.js';
import { authFrom } from '@market/punchouts.js';
import { handOffCard } from '../../lib/card-handoff.js';
import { addCartItem } from '../../stores/cart.js';
import AuthLink from '../AuthLink.jsx';
import CardArt from '../CardArt.jsx';
import { BigPrice } from './Basket.jsx';
import { gameHref } from '@market/game.js';

/** React `<Link to={href} state={{ card }} onClick={rememberCardId}>`: hand the tile to the desk. */
function openCard(card) {
  handOffCard(card);
  rememberCardId(card);
}

function Chevron(props) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        stroke-width="2.4"
        stroke-linecap="round"
        stroke-linejoin="round"
        d={props.dir < 0 ? 'M14.5 5 8 12l6.5 7' : 'M9.5 5 16 12l-6.5 7'}
      />
    </svg>
  );
}

/** Full-width carousel with Amazon's "Page 1 of 3" and side arrows. */
export function Shelf(props) {
  let track;
  const [page, setPage] = createSignal({ page: 1, pages: 1 });

  onSettled(() => {
    const el = track;
    if (!el) return undefined;
    const update = () => setPage(carouselPage({
      scrollLeft: el.scrollLeft,
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }));
    update();
    el.addEventListener('scroll', update, { passive: true });
    // Resizes and added/removed cards both change the page count.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(el);
    const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(update);
    mutations?.observe(el, { childList: true });
    return () => {
      el.removeEventListener('scroll', update);
      observer?.disconnect();
      mutations?.disconnect();
    };
  });

  function go(dir) {
    if (!track) return;
    track.scrollBy({ left: dir * Math.max(160, track.clientWidth - 48), behavior: 'smooth' });
  }

  return (
    <section class={['bk-card bk-shelf', props.class]}>
      <div class="bk-shelf-head">
        <h2>{props.title}</h2>
        {props.extra}
        <Show when={page().pages > 1}><span class="bk-pager">Page {page().page} of {page().pages}</span></Show>
      </div>
      <div class="bk-viewport">
        <Show when={page().pages > 1}>
          <button
            type="button"
            class="bk-arrow is-left"
            aria-label="Previous page"
            disabled={page().page <= 1}
            onClick={() => go(-1)}
          >
            <Chevron dir={-1} />
          </button>
        </Show>
        <div class="bk-track" ref={(el) => { track = el; }}>{props.children}</div>
        <Show when={page().pages > 1}>
          <button
            type="button"
            class="bk-arrow is-right"
            aria-label="Next page"
            disabled={page().page >= page().pages}
            onClick={() => go(1)}
          >
            <Chevron dir={1} />
          </button>
        </Show>
      </div>
    </section>
  );
}

/** Same pick as dropping a card on the cart: English NM first, then cheapest. */
export function AddCardButton(props) {
  const [state, setState] = createSignal('');
  async function add() {
    if (state() === 'busy' || state() === 'added') return;
    setState('busy');
    try {
      const listed = await fetchListings(String(props.card.id), { limit: 80 });
      const offer = pickCartOffer(listed?.listings || []);
      if (!offer) {
        setState('none');
        return;
      }
      addCartItem(cartItemFromOffer(tileStub(props.card), offer));
      setState('added');
    } catch (_) {
      setState('error');
    }
  }
  const label = () => ({ busy: 'Adding…', added: 'Added to cart', error: 'Try again' }[state()] || 'Add to cart');
  return (
    <Show when={state() !== 'none'} fallback={<span class="bk-oos">No copies listed</span>}>
      <button
        type="button"
        class={props.class || 'bk-btn-y is-small'}
        disabled={state() === 'busy' || state() === 'added'}
        onClick={add}
      >
        {label()}
      </button>
    </Show>
  );
}

function ViewCardLink(props) {
  return (
    <a class="bk-btn-o is-small bk-view" href={gameHref(props.href)} onClick={() => openCard(props.card)}>
      View card
    </a>
  );
}

/** Catalogue card in a carousel or grid: scan, name, printing, price, add. */
export function TileCard(props) {
  const card = () => props.card;
  const href = () => cardHref(card());
  const price = () => tilePricePkn(card());
  const identity = () => printingIdentity(card());
  const name = () => displayName(card());
  return (
    <div class="bk-pcard">
      <a class="bk-pcard-pic" href={gameHref(href())} onClick={() => openCard(card())}>
        <CardArt src={imageSrc(card(), 'grid')} alt={name()} loading="lazy" />
      </a>
      <a class="bk-pcard-title" href={gameHref(href())} onClick={() => openCard(card())}>
        {name()}
      </a>
      <Show when={identity().tileLine}><span class="bk-pcard-id">{identity().tileLine}</span></Show>
      <div class="bk-pcard-price">
        <Show when={price() > 0} fallback={<span class="bk-oos">No price yet</span>}>
          <span class="bk-from">from</span>
          <BigPrice pricePkn={price()} size="md" />
        </Show>
      </div>
      <Show when={props.note}><div class="bk-purchased">{props.note}</div></Show>
      <Show when={price() > 0} fallback={<ViewCardLink card={card()} href={href()} />}>
        <AddCardButton card={card()} />
      </Show>
    </div>
  );
}

function OfferFacets(props) {
  const language = () => listingLanguageFlag(props.offer.language);
  const tone = () => conditionTone(props.offer.condition) || 'nm';
  return (
    <span class="bk-pcard-facets">
      <img class={`bk-cond is-${tone()}`} src={conditionChipSrc(props.offer.condition)} alt="" width="30" height="21" />
      {conditionShort(props.offer.condition)}
      <Show when={language()}>
        {(lang) => (
          <>
            {' · '}
            <Show when={lang().src}><img class="bk-flag" src={lang().src} alt="" width="16" height="16" /></Show>
            {' '}
            {lang().label}
          </>
        )}
      </Show>
      <Show when={props.seller && props.offer.sellerUsername}>
        {' · '}{props.offer.sellerUsername}
      </Show>
    </span>
  );
}

/** One live listing from a seller already in the cart: adds that exact copy. */
export function ListingCard(props) {
  const [added, setAdded] = createSignal(false);
  const offer = () => props.offer;
  const stub = () => listingStub(offer());
  const image = () => cartImageFor(stub(), offer());
  const done = () => Boolean(props.inCart) || added();
  return (
    <div class="bk-pcard">
      <a class="bk-pcard-pic" href={gameHref(stub().canonicalPath)}>
        <Show when={image()} fallback={<span class="bk-pic-ph" />}>
          <CardArt src={homepageDerivativeUrl(image()) || image()} alt={stub().name} loading="lazy" />
        </Show>
      </a>
      <a class="bk-pcard-title" href={gameHref(stub().canonicalPath)}>{stub().name}</a>
      <span class="bk-pcard-id">
        {printingIdentity({ id: stub().id, set: offer().setName, number: offer().collectorNumber, imageUrl: image() }).tileLine}
      </span>
      <OfferFacets offer={offer()} />
      <div class="bk-pcard-price">
        <BigPrice pricePkn={offer().pricePkn} sellerAcceptsPkn={offer().sellerAcceptsPkn !== false} size="md" />
      </div>
      <button
        type="button"
        class="bk-btn-y is-small"
        disabled={done()}
        onClick={() => {
          if (!stub().id || !offer().id) return;
          addCartItem(cartItemFromOffer(stub(), offer()));
          setAdded(true);
        }}
      >
        {done() ? 'In your cart' : 'Add to cart'}
      </button>
    </div>
  );
}

/** Adds exactly the recommended listing; no second lookup. */
function OfferAddButton(props) {
  const [added, setAdded] = createSignal(false);
  const done = () => Boolean(props.inCart) || added();
  return (
    <button
      type="button"
      class={props.class || 'bk-btn-y is-small'}
      disabled={done()}
      onClick={() => {
        if (!props.offer?.id) return;
        addCartItem(cartItemFromOffer(offerStub(props.card, props.offer), props.offer));
        setAdded(true);
      }}
    >
      {done() ? 'In your cart' : 'Add to cart'}
    </button>
  );
}

/**
 * The buy button for a suggestion. The API already checked live listings, so
 * a card it sent without an offer has no copy for sale: link the card instead
 * of an Add to cart that can only fail. Client-side fallback cards (`known`
 * false) still look the listing up on click.
 */
function CardAction(props) {
  return (
    <Switch fallback={<AddCardButton card={props.card} class={props.class} />}>
      <Match when={props.offer}>
        <OfferAddButton card={props.card} offer={props.offer} inCart={props.inCart} class={props.class} />
      </Match>
      <Match when={props.known || !(tilePricePkn(props.card) > 0)}>
        <ViewCardLink card={props.card} href={props.href} />
      </Match>
    </Switch>
  );
}

/**
 * A recommendation: scan, name, printing, why it is here, the live offer
 * (condition, language, price) and one-tap add of that exact copy.
 */
export function RecCard(props) {
  const card = () => props.card;
  const href = () => cardHref(card());
  const identity = () => printingIdentity(card());
  const name = () => displayName(card());
  const fallbackPrice = () => tilePricePkn(card());
  return (
    <div class="bk-pcard">
      <a class="bk-pcard-pic" href={gameHref(href())} onClick={() => openCard(card())}>
        <CardArt src={imageSrc(card(), 'grid')} alt={name()} loading="lazy" />
      </a>
      <a class="bk-pcard-title" href={gameHref(href())} onClick={() => openCard(card())}>
        {name()}
      </a>
      <Show when={identity().tileLine}><span class="bk-pcard-id">{identity().tileLine}</span></Show>
      <Show when={props.reason}><span class="bk-pcard-why">{props.reason}</span></Show>
      <Show when={props.offer}>{(offer) => <OfferFacets offer={offer()} seller />}</Show>
      <div class="bk-pcard-price">
        <Switch fallback={<span class="bk-oos">No copies listed</span>}>
          <Match when={props.offer}>
            {(offer) => <BigPrice pricePkn={offer().pricePkn} sellerAcceptsPkn={offer().sellerAcceptsPkn !== false} size="md" />}
          </Match>
          <Match when={props.known}><span class="bk-unavailable">Currently unavailable</span></Match>
          <Match when={fallbackPrice() > 0}>
            <span class="bk-from">from</span>
            <BigPrice pricePkn={fallbackPrice()} size="md" />
          </Match>
        </Switch>
      </div>
      <Show when={props.note}><div class="bk-purchased">{props.note}</div></Show>
      <CardAction card={card()} offer={props.offer} inCart={props.inCart} known={props.known} href={href()} />
    </div>
  );
}

/** One server rail in the carousel layout. */
export function RailShelf(props) {
  const items = () => (props.rail?.items || []).filter((item) => item?.card?.id);
  return (
    <Show when={items().length}>
      <Shelf
        title={props.rail.title}
        extra={props.rail.subtitle ? <span class="bk-shelf-sub">{props.rail.subtitle}</span> : null}
      >
        <For each={items()}>
          {(item) => (
            <RecCard
              card={item.card}
              offer={item.offer}
              reason={item.reason}
              note={props.note ? props.note(item) : ''}
              inCart={Boolean(item.offer?.id && props.inCart?.has(String(item.offer.id)))}
              known
            />
          )}
        </For>
      </Shelf>
    </Show>
  );
}

/** Right-rail "Your recently viewed items": compact rows with Add to cart. */
export function RecentList(props) {
  return (
    <Show when={props.items?.length}>
      <div class="bk-card bk-recent">
        <h3>Your recently viewed cards</h3>
        <For each={props.items.slice(0, 5)}>
          {(item) => {
            const card = item.card;
            const href = cardHref(card);
            const unavailable = item.known && !item.offer;
            const price = item.offer ? Number(item.offer.pricePkn) : unavailable ? 0 : tilePricePkn(card);
            const identity = printingIdentity(card);
            const name = displayName(card);
            return (
              <div class={['bk-r-item', { 'is-unavailable': unavailable }]}>
                <a class="bk-r-pic" href={gameHref(href)} onClick={() => openCard(card)}>
                  <CardArt src={imageSrc(card, 'grid')} alt="" loading="lazy" />
                </a>
                <div class="bk-r-det">
                  <a class="bk-r-title" href={gameHref(href)} onClick={() => openCard(card)}>{name}</a>
                  <Show when={identity.tileLine}><span class="bk-r-id">{identity.tileLine}</span></Show>
                  <Show when={unavailable}><span class="bk-unavailable">Currently unavailable</span></Show>
                  <Show when={price > 0} fallback={unavailable ? null : <span class="bk-oos">No copies listed</span>}>
                    <div class="bk-r-price">
                      <Show when={!item.offer}><span class="bk-from">from</span></Show>
                      <BigPrice pricePkn={price} sellerAcceptsPkn={item.offer ? item.offer.sellerAcceptsPkn !== false : true} size="sm" />
                    </div>
                  </Show>
                  <CardAction card={card} offer={item.offer} known={item.known} href={href} />
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

/** "Your browsing history": a strip of small scans. */
export function ThumbShelf(props) {
  return (
    <Show when={props.cards?.length}>
      <Shelf title={props.title} extra={props.extra} class="is-thumbs">
        <For each={props.cards}>
          {(card) => (
            <a class="bk-thumb" href={gameHref(cardHref(card))} title={displayName(card)} onClick={() => handOffCard(card)}>
              <CardArt src={imageSrc(card, 'grid')} alt={displayName(card)} loading="lazy" />
            </a>
          )}
        </For>
      </Shelf>
    </Show>
  );
}

function SavedCard(props) {
  const row = () => props.row;
  const [watching, setWatching] = createSignal(untrack(() => readWatchlistIds().includes(String(props.row.cardId))));
  const href = () => row().href || '/marketplace';
  const language = () => listingLanguageFlag(row().language);
  const seller = () => publicShopSellerLabel(row()) || row().sellerName || 'Pokoin';
  const watchable = () => /^\d+$/.test(String(row().cardId || ''));
  return (
    <div class="bk-saved">
      <a class="bk-saved-pic" href={gameHref(href())}>
        <Show when={row().image} fallback={<span class="bk-pic-ph" />}>
          <CardArt src={homepageDerivativeUrl(row().image) || row().image} alt={row().name} loading="lazy" />
        </Show>
      </a>
      <div class="bk-saved-det">
        <a class="bk-saved-title" href={gameHref(href())}>{row().name}</a>
        <BigPrice pricePkn={row().pricePkn} sellerAcceptsPkn={row().sellerAcceptsPkn !== false} size="md" />
        <div class={row().unavailable ? 'bk-stock is-gone' : 'bk-stock'}>
          {row().unavailable ? 'Currently unavailable' : 'Listed'}
        </div>
        <div class="bk-saved-variant">
          <b>Condition:</b> {conditionShort(row().condition)}
          <Show when={language()}>{(lang) => <> · <b>Language:</b> {lang().label}</>}</Show>
          {' · '}{seller()}
        </div>
        <button type="button" class="bk-btn-o" disabled={row().unavailable} onClick={() => props.onMove()}>Move to cart</button>
        <div class="bk-row-links">
          <button type="button" class="bk-link" onClick={() => props.onDelete()}>Delete</button>
          <Show when={watchable()}>
            <button
              type="button"
              class="bk-link"
              onClick={() => {
                const on = toggleWatchlist(row().cardId);
                setWatching(on);
                postWatchlist(row().cardId, on ? 'add' : 'remove');
              }}
            >
              {watching() ? 'On your watchlist' : 'Add to watchlist'}
            </button>
          </Show>
          <a class="bk-link" href={gameHref(href())}>Compare offers</a>
        </div>
      </div>
    </div>
  );
}

/** "Your Items": Saved for later | Buy it again. */
export function YourItems(props) {
  const [tab, setTab] = createSignal(untrack(() => (props.saved.length || !props.signedIn ? 'saved' : 'again')));
  return (
    <section class="bk-your-items">
      <h2 class="bk-h1">Your Items</h2>
      <div class="bk-tabs" role="tablist" aria-label="Your Items">
        <button
          type="button"
          role="tab"
          aria-selected={tab() === 'saved'}
          class={{ 'is-on': tab() === 'saved' }}
          onClick={() => setTab('saved')}
        >
          Saved for later{props.saved.length ? ` (${props.saved.length} item${props.saved.length === 1 ? '' : 's'})` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab() === 'again'}
          class={{ 'is-on': tab() === 'again' }}
          onClick={() => setTab('again')}
        >
          Buy it again
        </button>
      </div>
      <div class="bk-card bk-panel" role="tabpanel">
        <Switch fallback={<p class="bk-empty-note">Cards from your paid orders show up here.</p>}>
          <Match when={tab() === 'saved' && props.saved.length}>
            <div class="bk-saved-grid">
              <For each={props.saved}>
                {(row) => (
                  <SavedCard
                    row={row}
                    onMove={() => props.onMove(row.id)}
                    onDelete={() => props.onDeleteSaved(row.id)}
                  />
                )}
              </For>
            </div>
          </Match>
          <Match when={tab() === 'saved'}>
            <p class="bk-empty-note">
              No cards saved for later. Use <b>Save for later</b> on a cart line to park it here without buying it.
            </p>
          </Match>
          <Match when={!props.signedIn}>
            <p class="bk-empty-note">
              <AuthLink class="bk-link" to={authFrom('/cart')}>Sign in</AuthLink> to see the cards you bought before.
            </p>
          </Match>
          <Match when={props.buyAgainLoading}>
            <p class="bk-empty-note">Loading your orders…</p>
          </Match>
          <Match when={props.buyAgain.length}>
            <div class="bk-again-grid">
              <For each={props.buyAgain}>
                {(item) => (
                  <RecCard card={item.card} offer={item.offer || null} note={item.note} known={Boolean(item.known)} />
                )}
              </For>
            </div>
          </Match>
        </Switch>
      </div>
    </section>
  );
}
