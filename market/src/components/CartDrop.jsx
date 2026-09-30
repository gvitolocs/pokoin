import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchArtist, fetchExpansionCards, fetchListings } from '../api.js';
import { addCatalogCards } from '../cart-add.js';
import { cartDropThumb } from '../cart-drop-size.js';
import { pickCartOffer } from '../cart-offer.js';
import { cartItemFromOffer, useCart } from '../cart.jsx';
import { bundleOf, LISTING_DRAG_TYPE, readListingDrag } from '../chat-listing.js';
import { fetchSpeciesCards } from '../species-cards.js';
import {
  acceptTrayDrop,
  cartItemReference,
  endTrayDrag,
  startTrayDrag,
  TRAY_CART,
} from '../tray-drag.js';
import { TRAY_FULL_ART_MAX, TRAY_VISIBLE } from '../tray-render.js';
import CardArt from './CardArt.jsx';
import QtyStepper from './QtyStepper.jsx';

const BUNDLE_MAX = 400;

export default function CartDrop({ onAdd }) {
  const { items, setQty, removeItem } = useCart();
  const [over, setOver] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // A dropped artist can fill the cart: mount small thumbs, not hundreds of scans.
  const shown = showAll ? items : items.slice(0, TRAY_VISIBLE);
  const thumb = cartDropThumb(shown.length);
  const fullArt = items.length <= TRAY_FULL_ART_MAX;

  return (
    <div
      className={`cart-drop${over ? ' is-over' : ''}`}
      role="region"
      aria-label="Add to cart"
      onDragOver={(event) => {
        if (![...(event.dataTransfer?.types || [])].includes(LISTING_DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setOver(false);
      }}
      onDrop={(event) => {
        if (![...(event.dataTransfer?.types || [])].includes(LISTING_DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        acceptTrayDrop(TRAY_CART);
        const reference = readListingDrag(event);
        if (!reference) return;
        if (reference.kind === 'cards') {
          void addDraggedGroup(reference.cards || [], onAdd);
          return;
        }
        if (bundleOf(reference)) {
          void addBundle(reference, onAdd);
          return;
        }
        if (!reference.cardId) return;
        void addDraggedCard(reference, onAdd);
      }}
    >
      <strong>Cart</strong>
      <p>Drop a card, a Pokémon, an artist, or a set.</p>
      {items.length ? (
        <div className="cart-drop-grid">
          {shown.map((row) => (
            <span
              key={row.id}
              className="cart-drop-card"
              style={{ width: thumb, height: Math.round(thumb * 88 / 63) }}
              draggable
              onDragStart={(event) => {
                const reference = cartItemReference(row);
                if (!reference) {
                  event.preventDefault();
                  return;
                }
                event.stopPropagation();
                startTrayDrag(event, {
                  tray: TRAY_CART,
                  reference,
                  remove: () => removeItem(row.id),
                });
              }}
              onDragEnd={() => endTrayDrag()}
            >
              <Link to={row.href || '/cart'} title={row.name} draggable={false}>
                {row.image ? <CardArt src={row.image} alt="" full={fullArt} /> : <span className="suggest-ph" />}
              </Link>
              <QtyStepper
                qty={row.qty}
                max={row.stock || 99}
                onChange={(next) => setQty(row.id, next)}
              />
            </span>
          ))}
          {items.length > TRAY_VISIBLE ? (
            <button
              type="button"
              className="btn ghost desktop-drop-more"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? 'Show fewer' : `+${items.length - TRAY_VISIBLE} more · Show all`}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="cart-drop-empty">
          <div className="empty-art" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28">
              <path fill="currentColor" d="M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1 1 0 0 0 20 4H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z" />
            </svg>
          </div>
          <p>Cart is empty</p>
        </div>
      )}
    </div>
  );
}

function catalogCard(card, fallbackName) {
  const id = String(card?.id || card?.card_id || '');
  return {
    id,
    name: card?.name || fallbackName || 'Card',
    canonicalPath: card?.canonicalPath || card?.canonical_path || (id ? `/marketplace/en/cards/${id}` : ''),
    imageUrl: card?.imageUrl || card?.image_url || '',
    gridImageUrl: card?.gridImageUrl || card?.cdn_image_url || '',
    heroImageUrl: card?.heroImageUrl || '',
  };
}

async function addDraggedGroup(rows, onAdd) {
  const listings = [];
  const catalog = [];
  for (const row of rows || []) {
    if (row?.kind === 'listing' && row.listingId) listings.push(row);
    else if (row?.cardId || row?.id) catalog.push(row);
  }
  for (const row of listings) {
    await addDraggedCard(row, onAdd);
  }
  if (catalog.length) await addCatalogCards(catalog, onAdd);
}

async function addBundle(reference, onAdd) {
  const bundle = bundleOf(reference);
  if (!bundle?.slug) return;
  const cards = bundle.kind === 'artist'
    ? (await fetchArtist(bundle.slug, { limit: 6000 }).catch(() => null))?.cards || []
    : bundle.kind === 'species'
      ? await fetchSpeciesCards(decodeURIComponent(bundle.slug)).catch(() => [])
      : (await fetchExpansionCards({ slug: bundle.slug }).catch(() => null))?.cards || [];
  // Listed printings first; the cart holds BUNDLE_MAX lines anyway.
  const queue = [...cards]
    .sort((a, b) => Number(hasListingSignal(b)) - Number(hasListingSignal(a)))
    .slice(0, BUNDLE_MAX);
  const found = [];
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const card = queue[cursor];
      cursor += 1;
      const shaped = catalogCard(card, reference.cardName);
      if (!shaped.id) continue;
      const listed = await fetchListings(shaped.id, { limit: 40 }).catch(() => null);
      const offer = pickCartOffer(listed?.listings || []);
      if (offer) found.push(cartItemFromOffer(shaped, offer));
    }
  }
  const width = Math.min(6, queue.length);
  await Promise.all(Array.from({ length: width }, () => worker()));
  // One synchronous burst: React batches it into a single cart render + write
  // instead of hundreds of re-renders while the requests trickle in.
  for (const item of found) onAdd(item);
}

function hasListingSignal(card) {
  return Number(card?.listed_quantity || card?.listedQuantity || 0) > 0
    || Number(card?.lowest_price_pkn || card?.pricePkn || 0) > 0;
}

async function addDraggedCard(reference, onAdd) {
  if (reference.kind === 'listing' && reference.listingId && Number(reference.pricePkn) > 0) {
    onAdd(cartItemFromOffer(
      { id: reference.cardId, name: reference.cardName, canonicalPath: reference.path, imageUrl: reference.imageUrl },
      {
        id: reference.listingId,
        pricePkn: reference.pricePkn,
        sellerUid: reference.sellerUid,
        sellerName: reference.sellerName || reference.seller,
        sellerCountry: reference.sellerCountry || '',
        cardImageUrl: reference.imageUrl,
        condition: reference.condition || 'NM',
        language: reference.language || '',
        reverse: reference.reverse,
        firstEdition: reference.firstEdition,
        graded: reference.graded,
        grade: reference.grade,
        qty: reference.qty,
        quantityAvailable: reference.stock,
      },
    ));
    return;
  }
  const listed = await fetchListings(reference.cardId, { limit: 80 }).catch(() => null);
  const offer = pickCartOffer(listed?.listings || []);
  if (!offer) return;
  onAdd(cartItemFromOffer(
    { id: reference.cardId, name: reference.cardName, canonicalPath: reference.path, imageUrl: reference.imageUrl },
    { ...offer, qty: reference.qty },
  ));
}
