import { createSignal, For, Show } from 'solid-js';
import { addCartDrop } from '@market/cart-drop-add.js';
import { cartDropThumb } from '@market/cart-drop-size.js';
import { readListingDrag } from '@market/chat-listing.js';
import { acceptTrayDrop, cartItemReference, endTrayDrag, startTrayDrag, TRAY_CART } from '@market/tray-drag.js';
import { TRAY_FULL_ART_MAX, TRAY_VISIBLE } from '@market/tray-render.js';
import { carriesListing } from '../lib/drag.js';
import { addCartItem, cartItems, removeCartItem, setCartQty } from '../stores/cart.js';
import CardArt from './CardArt.jsx';
import QtyStepper from './QtyStepper.jsx';

const CART_ICON = 'M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1 1 0 0 0 20 4H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z';

/**
 * Header cart tray (market/src/components/CartDrop.jsx): drop a card, a
 * Pokémon, an artist or a set to add it; drag a thumb out to move it.
 * Its own chunk — it mounts only while hovered or while a card is dragged.
 */
export default function CartDrop() {
  const [over, setOver] = createSignal(false);
  const [showAll, setShowAll] = createSignal(false);
  // A dropped artist can fill the cart: mount small thumbs, not hundreds of scans.
  const shown = () => (showAll() ? cartItems() : cartItems().slice(0, TRAY_VISIBLE));
  const thumb = () => cartDropThumb(shown().length);
  const fullArt = () => cartItems().length <= TRAY_FULL_ART_MAX;

  return (
    <div
      class={['cart-drop', { 'is-over': over() }]}
      role="region"
      aria-label="Add to cart"
      onDragOver={(event) => {
        if (!carriesListing(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setOver(false);
      }}
      onDrop={(event) => {
        if (!carriesListing(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        acceptTrayDrop(TRAY_CART);
        void addCartDrop(readListingDrag(event), addCartItem);
      }}
    >
      <strong>Cart</strong>
      <p>Drop a card, a Pokémon, an artist, or a set.</p>
      <Show
        when={cartItems().length}
        fallback={(
          <div class="cart-drop-empty">
            <div class="empty-art" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d={CART_ICON} /></svg>
            </div>
            <p>Cart is empty</p>
          </div>
        )}
      >
        <div class="cart-drop-grid">
          <For each={shown()} keyed={(row) => row.id}>
            {(row) => (
              <span
                class="cart-drop-card"
                style={{ width: `${thumb()}px`, height: `${Math.round(thumb() * 88 / 63)}px` }}
                draggable="true"
                onDragStart={(event) => {
                  const reference = cartItemReference(row());
                  if (!reference) {
                    event.preventDefault();
                    return;
                  }
                  event.stopPropagation();
                  const id = row().id;
                  startTrayDrag(event, { tray: TRAY_CART, reference, remove: () => removeCartItem(id) });
                }}
                onDragEnd={() => endTrayDrag()}
              >
                <a href={row().href || '/cart'} title={row().name} draggable="false">
                  <Show when={row().image} fallback={<span class="suggest-ph" />}>
                    <CardArt src={row().image} alt="" full={fullArt()} />
                  </Show>
                </a>
                <QtyStepper qty={row().qty} max={row().stock || 99} onChange={(next) => setCartQty(row().id, next)} />
              </span>
            )}
          </For>
          <Show when={cartItems().length > TRAY_VISIBLE}>
            <button type="button" class="btn ghost desktop-drop-more" onClick={() => setShowAll((value) => !value)}>
              {showAll() ? 'Show fewer' : `+${cartItems().length - TRAY_VISIBLE} more · Show all`}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
