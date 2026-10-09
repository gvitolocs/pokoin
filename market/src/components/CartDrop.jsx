import { useState } from 'react';
import { Link } from 'react-router-dom';
import { cartDropThumb } from '../cart-drop-size.js';
import { addCartDrop } from '../cart-drop-add.js';
import { useCart } from '../cart.jsx';
import { LISTING_DRAG_TYPE, readListingDrag } from '../chat-listing.js';
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
        void addCartDrop(readListingDrag(event), onAdd);
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
