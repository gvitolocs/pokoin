import { Show } from 'solid-js';
import { isLandscapePrintName } from '@market/art-cut-landscape.js';
import { getChatDock } from '@market/chat-dock-store.js';
import { referenceForPeer, writeListingDrag } from '@market/chat-listing.js';
import { cardImageAlt } from '@market/seo.js';
import CardArt from '../CardArt.jsx';

/** Drag payload for the desk scan: the open chat peer's listing when there is one. */
export function dragThisCard(card, offers) {
  const dock = getChatDock();
  const username = dock.peerLabel && dock.peerLabel !== 'Seller' ? dock.peerLabel : '';
  return referenceForPeer(card, offers, { uid: dock.peer, username });
}

export function isLandscapeDesk(card) {
  return isLandscapePrintName(card?.name)
    || String(card?.artLayout || card?.art_layout || '').toLowerCase() === 'landscape';
}

export function Chevron(props) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d={props.dir === 'left'
          ? 'M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z'
          : 'M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z'}
      />
    </svg>
  );
}

/**
 * The large desk scan (market/src/pages/Card.jsx DeskArtFrame): click or
 * Enter/Space zooms; dragging drops the card (or the open chat's listing).
 * Page multi-select (rubber band) is not ported yet, so it drags one card.
 */
export default function DeskArtFrame(props) {
  const id = () => String(props.card?.id || '');
  return (
    <div
      role="button"
      tabindex="0"
      class={['art-frame', { 'is-landscape': isLandscapeDesk(props.card) }]}
      data-card-id={id() || undefined}
      draggable="true"
      onClick={() => props.onZoom?.()}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        props.onZoom?.();
      }}
      onDragStart={(event) => writeListingDrag(event, dragThisCard(props.card, props.offers || []))}
    >
      <Show when={props.art} fallback={<span class="tile-ph" />}>
        <CardArt
          src={props.art}
          card={props.card}
          alt={cardImageAlt(props.card)}
          fetchPriority="high"
          full
          onError={() => {
            console.warn('[pokoin:desk-art] hero failed', {
              cardId: props.card?.id,
              art: props.art,
              imageUrl: props.card?.imageUrl,
              heroImageUrl: props.card?.heroImageUrl,
            });
          }}
        />
      </Show>
    </div>
  );
}
