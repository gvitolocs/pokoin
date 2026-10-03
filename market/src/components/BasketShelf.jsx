// Cart rails in Amazon's layout: paged carousels, product cards with
// "Add to cart", the recently-viewed column and the Your Items tabs.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  cardHref,
  fetchListings,
  imageSrc,
  postWatchlist,
  readWatchlistIds,
  rememberCardId,
  toggleWatchlist,
} from '../api.js';
import { cartImageFor } from '../cart-image.js';
import { carouselPage } from '../cart-model.js';
import { pickCartOffer } from '../cart-offer.js';
import { cartItemFromOffer, useCart } from '../cart.jsx';
import { displayName, printingIdentity } from '../identity.js';
import { homepageDerivativeUrl } from '../image-urls.js';
import {
  conditionChipSrc,
  conditionShort,
  conditionTone,
  listingLanguageFlag,
  publicShopSellerLabel,
} from '../listing-meta.js';
import { tilePricePkn } from '../pkn.js';
import { authFrom } from '../punchouts.js';
import { BigPrice } from './Basket.jsx';
import CardArt from './CardArt.jsx';

function Chevron({ dir }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        d={dir < 0 ? 'M14.5 5 8 12l6.5 7' : 'M9.5 5 16 12l-6.5 7'}
      />
    </svg>
  );
}

/** Full-width carousel with Amazon's "Page 1 of 3" and side arrows. */
export function Shelf({ title, extra, count, children, className = '' }) {
  const track = useRef(null);
  const [page, setPage] = useState({ page: 1, pages: 1 });

  useEffect(() => {
    const el = track.current;
    if (!el) return undefined;
    const update = () => setPage(carouselPage({
      scrollLeft: el.scrollLeft,
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }));
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [count]);

  function go(dir) {
    const el = track.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth - 48), behavior: 'smooth' });
  }

  return (
    <section className={`bk-card bk-shelf${className ? ` ${className}` : ''}`}>
      <div className="bk-shelf-head">
        <h2>{title}</h2>
        {extra}
        {page.pages > 1 ? <span className="bk-pager">Page {page.page} of {page.pages}</span> : null}
      </div>
      <div className="bk-viewport">
        {page.pages > 1 ? (
          <button
            type="button"
            className="bk-arrow is-left"
            aria-label="Previous page"
            disabled={page.page <= 1}
            onClick={() => go(-1)}
          >
            <Chevron dir={-1} />
          </button>
        ) : null}
        <div className="bk-track" ref={track}>{children}</div>
        {page.pages > 1 ? (
          <button
            type="button"
            className="bk-arrow is-right"
            aria-label="Next page"
            disabled={page.page >= page.pages}
            onClick={() => go(1)}
          >
            <Chevron dir={1} />
          </button>
        ) : null}
      </div>
    </section>
  );
}

function tileStub(card) {
  return {
    id: String(card.id),
    name: card.name || 'Card',
    canonicalPath: card.canonicalPath || card.canonical_path || '',
    imageUrl: card.imageUrl || card.image_url || '',
    gridImageUrl: card.gridImageUrl || card.grid_image_url || '',
    heroImageUrl: card.heroImageUrl || '',
    homepageImageUrl: card.homepageImageUrl || card.homepage_image_url || '',
    set: card.set || card.expansion || card.setName || '',
  };
}

/** Same pick as dropping a card on the cart: English NM first, then cheapest. */
export function AddCardButton({ card, className = 'bk-btn-y is-small' }) {
  const { addItem } = useCart();
  const [state, setState] = useState('');
  async function add() {
    if (state === 'busy' || state === 'added') return;
    setState('busy');
    try {
      const listed = await fetchListings(String(card.id), { limit: 80 });
      const offer = pickCartOffer(listed?.listings || []);
      if (!offer) {
        setState('none');
        return;
      }
      addItem(cartItemFromOffer(tileStub(card), offer));
      setState('added');
    } catch (_) {
      setState('error');
    }
  }
  const label = {
    busy: 'Adding…',
    added: 'Added to cart',
    none: 'No copies listed',
    error: 'Try again',
  }[state] || 'Add to cart';
  return (
    <button
      type="button"
      className={className}
      disabled={state === 'busy' || state === 'added' || state === 'none'}
      onClick={add}
    >
      {label}
    </button>
  );
}

/** Catalogue card in a carousel or grid: scan, name, printing, price, add. */
export function TileCard({ card, note }) {
  const href = cardHref(card);
  const price = tilePricePkn(card);
  const identity = printingIdentity(card);
  const name = displayName(card);
  return (
    <div className="bk-pcard">
      <Link className="bk-pcard-pic" to={href} state={{ card }} onClick={() => rememberCardId(card)}>
        <CardArt src={imageSrc(card, 'grid')} alt={name} loading="lazy" />
      </Link>
      <Link className="bk-pcard-title" to={href} state={{ card }} onClick={() => rememberCardId(card)}>
        {name}
      </Link>
      {identity.tileLine ? <span className="bk-pcard-id">{identity.tileLine}</span> : null}
      <div className="bk-pcard-price">
        {price > 0 ? (
          <>
            <span className="bk-from">from</span>
            <BigPrice pricePkn={price} size="md" />
          </>
        ) : <span className="bk-oos">No price yet</span>}
      </div>
      {note ? <div className="bk-purchased">{note}</div> : null}
      <AddCardButton card={card} />
    </div>
  );
}

function listingStub(offer) {
  const id = String(offer.cardId || offer.card_id || '');
  return {
    id,
    name: offer.cardName || offer.name || 'Card',
    canonicalPath: offer.canonicalPath || offer.canonical_path || `/marketplace/en/cards/${id}`,
    imageUrl: offer.cardImageUrl || offer.imageUrl || '',
    homepageImageUrl: offer.homepageImageUrl || '',
    gridImageUrl: offer.gridImageUrl || '',
    set: offer.setName || '',
  };
}

/** One live listing from a seller already in the cart: adds that exact copy. */
export function ListingCard({ offer, inCart }) {
  const { addItem } = useCart();
  const [added, setAdded] = useState(false);
  const stub = listingStub(offer);
  const image = cartImageFor(stub, offer);
  const language = listingLanguageFlag(offer.language);
  const tone = conditionTone(offer.condition) || 'nm';
  const done = inCart || added;
  return (
    <div className="bk-pcard">
      <Link className="bk-pcard-pic" to={stub.canonicalPath}>
        {image ? <CardArt src={homepageDerivativeUrl(image) || image} alt={stub.name} loading="lazy" /> : <span className="bk-pic-ph" />}
      </Link>
      <Link className="bk-pcard-title" to={stub.canonicalPath}>{stub.name}</Link>
      <span className="bk-pcard-id">
        {printingIdentity({ id: stub.id, set: offer.setName, number: offer.collectorNumber, imageUrl: image }).tileLine}
      </span>
      <span className="bk-pcard-facets">
        <img className={`bk-cond is-${tone}`} src={conditionChipSrc(offer.condition)} alt="" width="30" height="21" />
        {conditionShort(offer.condition)}
        {language ? (
          <>
            {' · '}
            {language.src ? <img className="bk-flag" src={language.src} alt="" width="16" height="16" /> : null}
            {' '}
            {language.label}
          </>
        ) : null}
      </span>
      <div className="bk-pcard-price">
        <BigPrice pricePkn={offer.pricePkn} sellerAcceptsPkn={offer.sellerAcceptsPkn !== false} size="md" />
      </div>
      <button
        type="button"
        className="bk-btn-y is-small"
        disabled={done}
        onClick={() => {
          if (!stub.id || !offer.id) return;
          addItem(cartItemFromOffer(stub, offer));
          setAdded(true);
        }}
      >
        {done ? 'In your cart' : 'Add to cart'}
      </button>
    </div>
  );
}

function offerStub(card, offer) {
  const id = String(card?.id || card?.card_id || offer?.cardId || '');
  return {
    id,
    name: card?.name || offer?.cardName || 'Card',
    canonicalPath: card?.canonicalPath || card?.canonical_path || offer?.canonicalPath || `/marketplace/en/cards/${id}`,
    imageUrl: card?.imageUrl || card?.image_url || offer?.cardImageUrl || '',
    gridImageUrl: card?.gridImageUrl || '',
    heroImageUrl: card?.heroImageUrl || '',
    homepageImageUrl: card?.homepageImageUrl || '',
    set: card?.set || card?.set_name || offer?.setName || '',
  };
}

/** Adds exactly the recommended listing; no second lookup. */
function OfferAddButton({ card, offer, inCart = false, className = 'bk-btn-y is-small' }) {
  const { addItem } = useCart();
  const [added, setAdded] = useState(false);
  const done = inCart || added;
  return (
    <button
      type="button"
      className={className}
      disabled={done}
      onClick={() => {
        if (!offer?.id) return;
        addItem(cartItemFromOffer(offerStub(card, offer), offer));
        setAdded(true);
      }}
    >
      {done ? 'In your cart' : 'Add to cart'}
    </button>
  );
}

/**
 * A recommendation: scan, name, printing, why it is here, the live offer
 * (condition, language, price) and one-tap add of that exact copy.
 */
export function RecCard({ card, offer, reason = '', note = '', inCart = false }) {
  const href = cardHref(card);
  const identity = printingIdentity(card);
  const name = displayName(card);
  const language = offer ? listingLanguageFlag(offer.language) : null;
  const tone = offer ? conditionTone(offer.condition) || 'nm' : 'nm';
  const fallbackPrice = tilePricePkn(card);
  return (
    <div className="bk-pcard">
      <Link className="bk-pcard-pic" to={href} state={{ card }} onClick={() => rememberCardId(card)}>
        <CardArt src={imageSrc(card, 'grid')} alt={name} loading="lazy" />
      </Link>
      <Link className="bk-pcard-title" to={href} state={{ card }} onClick={() => rememberCardId(card)}>
        {name}
      </Link>
      {identity.tileLine ? <span className="bk-pcard-id">{identity.tileLine}</span> : null}
      {reason ? <span className="bk-pcard-why">{reason}</span> : null}
      {offer ? (
        <span className="bk-pcard-facets">
          <img className={`bk-cond is-${tone}`} src={conditionChipSrc(offer.condition)} alt="" width="30" height="21" />
          {conditionShort(offer.condition)}
          {language ? (
            <>
              {' · '}
              {language.src ? <img className="bk-flag" src={language.src} alt="" width="16" height="16" /> : null}
              {' '}
              {language.label}
            </>
          ) : null}
          {offer.sellerUsername ? <>{' · '}{offer.sellerUsername}</> : null}
        </span>
      ) : null}
      <div className="bk-pcard-price">
        {offer ? (
          <BigPrice pricePkn={offer.pricePkn} sellerAcceptsPkn={offer.sellerAcceptsPkn !== false} size="md" />
        ) : fallbackPrice > 0 ? (
          <>
            <span className="bk-from">from</span>
            <BigPrice pricePkn={fallbackPrice} size="md" />
          </>
        ) : <span className="bk-oos">No copies listed</span>}
      </div>
      {note ? <div className="bk-purchased">{note}</div> : null}
      {offer ? <OfferAddButton card={card} offer={offer} inCart={inCart} /> : <AddCardButton card={card} />}
    </div>
  );
}

/** One server rail in the carousel layout. */
export function RailShelf({ rail, inCart, note }) {
  const items = (rail?.items || []).filter((item) => item?.card?.id);
  if (!items.length) return null;
  return (
    <Shelf
      title={rail.title}
      extra={rail.subtitle ? <span className="bk-shelf-sub">{rail.subtitle}</span> : null}
      count={items.length}
    >
      {items.map((item) => (
        <RecCard
          key={`${rail.id}:${item.card.id}:${item.offer?.id || ''}`}
          card={item.card}
          offer={item.offer}
          reason={item.reason}
          note={note ? note(item) : ''}
          inCart={Boolean(item.offer?.id && inCart?.has(String(item.offer.id)))}
        />
      ))}
    </Shelf>
  );
}

/** Right-rail "Your recently viewed items": compact rows with Add to cart. */
export function RecentList({ items }) {
  if (!items?.length) return null;
  return (
    <div className="bk-card bk-recent">
      <h3>Your recently viewed cards</h3>
      {items.slice(0, 5).map(({ card, offer }) => {
        const href = cardHref(card);
        const price = offer ? Number(offer.pricePkn) : tilePricePkn(card);
        const identity = printingIdentity(card);
        const name = displayName(card);
        return (
          <div className="bk-r-item" key={card.id}>
            <Link className="bk-r-pic" to={href} state={{ card }}>
              <CardArt src={imageSrc(card, 'grid')} alt="" loading="lazy" />
            </Link>
            <div className="bk-r-det">
              <Link className="bk-r-title" to={href} state={{ card }}>{name}</Link>
              {identity.tileLine ? <span className="bk-r-id">{identity.tileLine}</span> : null}
              {price > 0 ? (
                <div className="bk-r-price">
                  {offer ? null : <span className="bk-from">from</span>}
                  <BigPrice pricePkn={price} sellerAcceptsPkn={offer ? offer.sellerAcceptsPkn !== false : true} size="sm" />
                </div>
              ) : null}
              {offer ? <OfferAddButton card={card} offer={offer} /> : <AddCardButton card={card} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** "Your browsing history": a strip of small scans. */
export function ThumbShelf({ title, cards, extra }) {
  if (!cards?.length) return null;
  return (
    <Shelf title={title} extra={extra} count={cards.length} className="is-thumbs">
      {cards.map((card) => (
        <Link
          key={card.id}
          className="bk-thumb"
          to={cardHref(card)}
          state={{ card }}
          title={displayName(card)}
        >
          <CardArt src={imageSrc(card, 'grid')} alt={displayName(card)} loading="lazy" />
        </Link>
      ))}
    </Shelf>
  );
}

function SavedCard({ row, onMove, onDelete }) {
  const [watching, setWatching] = useState(() => readWatchlistIds().includes(String(row.cardId)));
  const href = row.href || '/marketplace';
  const language = listingLanguageFlag(row.language);
  const seller = publicShopSellerLabel(row) || row.sellerName || 'Pokoin';
  const watchable = /^\d+$/.test(String(row.cardId || ''));
  return (
    <div className="bk-saved">
      <Link className="bk-saved-pic" to={href}>
        {row.image
          ? <CardArt src={homepageDerivativeUrl(row.image) || row.image} alt={row.name} loading="lazy" />
          : <span className="bk-pic-ph" />}
      </Link>
      <div className="bk-saved-det">
        <Link className="bk-saved-title" to={href}>{row.name}</Link>
        <BigPrice pricePkn={row.pricePkn} sellerAcceptsPkn={row.sellerAcceptsPkn !== false} size="md" />
        <div className={row.unavailable ? 'bk-stock is-gone' : 'bk-stock'}>
          {row.unavailable ? 'Currently unavailable' : 'Listed'}
        </div>
        <div className="bk-saved-variant">
          <b>Condition:</b> {conditionShort(row.condition)}
          {language ? <> · <b>Language:</b> {language.label}</> : null}
          {' · '}{seller}
        </div>
        <button type="button" className="bk-btn-o" disabled={row.unavailable} onClick={onMove}>Move to cart</button>
        <div className="bk-row-links">
          <button type="button" className="bk-link" onClick={onDelete}>Delete</button>
          {watchable ? (
            <button
              type="button"
              className="bk-link"
              onClick={() => {
                const on = toggleWatchlist(row.cardId);
                setWatching(on);
                postWatchlist(row.cardId, on ? 'add' : 'remove');
              }}
            >
              {watching ? 'On your watchlist' : 'Add to watchlist'}
            </button>
          ) : null}
          <Link className="bk-link" to={href}>Compare offers</Link>
        </div>
      </div>
    </div>
  );
}

/** "Your Items": Saved for later | Buy it again. */
export function YourItems({ saved, buyAgain, buyAgainLoading, signedIn, onMove, onDeleteSaved }) {
  const [tab, setTab] = useState(() => (saved.length || !signedIn ? 'saved' : 'again'));
  return (
    <section className="bk-your-items">
      <h2 className="bk-h1">Your Items</h2>
      <div className="bk-tabs" role="tablist" aria-label="Your Items">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'saved'}
          className={tab === 'saved' ? 'is-on' : ''}
          onClick={() => setTab('saved')}
        >
          Saved for later{saved.length ? ` (${saved.length} item${saved.length === 1 ? '' : 's'})` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'again'}
          className={tab === 'again' ? 'is-on' : ''}
          onClick={() => setTab('again')}
        >
          Buy it again
        </button>
      </div>
      <div className="bk-card bk-panel" role="tabpanel">
        {tab === 'saved' ? (
          saved.length ? (
            <div className="bk-saved-grid">
              {saved.map((row) => (
                <SavedCard
                  key={row.id}
                  row={row}
                  onMove={() => onMove(row.id)}
                  onDelete={() => onDeleteSaved(row.id)}
                />
              ))}
            </div>
          ) : (
            <p className="bk-empty-note">
              No cards saved for later. Use <b>Save for later</b> on a cart line to park it here without buying it.
            </p>
          )
        ) : !signedIn ? (
          <p className="bk-empty-note">
            <Link className="bk-link" to={authFrom('/cart')}>Sign in</Link> to see the cards you bought before.
          </p>
        ) : buyAgainLoading ? (
          <p className="bk-empty-note">Loading your orders…</p>
        ) : buyAgain.length ? (
          <div className="bk-again-grid">
            {buyAgain.map(({ card, offer, note }) => (
              <RecCard key={card.id} card={card} offer={offer || null} note={note} />
            ))}
          </div>
        ) : (
          <p className="bk-empty-note">Cards from your paid orders show up here.</p>
        )}
      </div>
    </section>
  );
}
