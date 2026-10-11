import { createMemo, For, onSettled, Show } from 'solid-js';
import { isFeatureAlbumArt, isLandscapePrintName, resolveArtLayout } from '@market/art-cut.js';
import { albumShadeStyle } from '@market/art-shade.js';
import { cardHref, formatPkn, imageSrc, rememberCardId } from '@market/api.js';
import { printingIdentity } from '@market/identity.js';
import { tilePricePkn } from '@market/pkn.js';
import { pileCardTier } from '@market/search-filters.js';
import { cardImageAlt } from '@market/seo.js';
import { Action, track } from '@market/track.js';
import { handOffCard } from '../lib/card-handoff.js';
import CardArt from './CardArt.jsx';
import { useCardSelect } from './CardSelectGrid.jsx';

/**
 * Artist album tile for a same-artwork group: stacked sheets + count chip
 * (market/src/components/ArtworkPile.jsx). A plain click opens the pile
 * overlay; Ctrl/Cmd/Shift extend the grid selection like CardTile.
 */
export function ArtistPileTile(props) {
  const rep = () => props.group.cards[0];
  const select = useCardSelect();
  const picked = () => Boolean(select?.isSelected(rep()?.id));
  const identity = () => printingIdentity(rep());
  const landscape = () => isLandscapePrintName(rep().name);
  const item = () => resolveArtLayout(rep()) === 'item';
  const tall = () => !landscape() && isFeatureAlbumArt(rep());
  const hero = () => imageSrc(rep(), 'hero');

  function prefetch() {
    if (hero()) {
      const img = new Image();
      img.src = hero();
    }
  }

  function onTileClick(event) {
    if (select && (event.metaKey || event.ctrlKey || event.shiftKey)) {
      event.preventDefault();
      select.click(rep().id, event);
      return;
    }
    event.preventDefault();
    props.onOpen(props.group);
  }

  return (
    <Show when={rep()?.id}>
      <div class={['tile-pile-wrap', { 'tile-pile-tall': tall() }]}>
        <span class="tile-pile-sheet s2" aria-hidden="true" />
        <span class="tile-pile-sheet s1" aria-hidden="true" />
        <a
          class={['tile', 'tile-cut tile-album', {
            'tile-tall': tall(),
            'tile-item': item(),
            'is-landscape': landscape(),
            'is-selected': picked(),
          }]}
          href={cardHref(rep())}
          data-card-id={rep().id}
          aria-selected={picked() ? 'true' : undefined}
          aria-label={`${rep().name}, ${props.group.cards.length} printings of the same artwork`}
          onClick={onTileClick}
          onPointerEnter={prefetch}
          style={albumShadeStyle(rep())}
        >
          <span class="tile-art">
            <Show when={hero()} fallback={<span class="tile-ph" />}>
              <CardArt
                src={hero()}
                alt={cardImageAlt(rep())}
                cut={!landscape() && !item()}
                cutSurface="album"
                full
                card={rep()}
                loading={props.rank != null && props.rank < 8 ? 'eager' : 'lazy'}
                fetchPriority={props.rank != null && props.rank < 4 ? 'high' : undefined}
              />
            </Show>
          </span>
          <span class="tile-pile-count" aria-hidden="true">×{props.group.cards.length}</span>
          <div class="tile-meta">
            <Show when={identity().tileLine}><em class="tile-id">{identity().tileLine}</em></Show>
          </div>
        </a>
      </div>
    </Show>
  );
}

/**
 * Popup over an artist pile: every printing of the artwork as a full card,
 * each linking to its card desk. Esc / backdrop click / ✕ close it.
 */
export function ArtworkPileOverlay(props) {
  let closeButton;
  const rep = () => props.group.cards[0];
  // Normal printing first, then Poké Ball, then Master Ball, then the rest —
  // stable within tiers so the desk order holds.
  const orderedCards = createMemo(() => [...props.group.cards].sort((a, b) => pileCardTier(a) - pileCardTier(b)));

  onSettled(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  });

  return (
    <div class="artwork-pile-backdrop" onClick={() => props.onClose()}>
      <div
        class="artwork-pile-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`${rep()?.name || 'Artwork'} printings`}
      >
        <header class="artwork-pile-head">
          <div class="artwork-pile-title">
            <strong>{rep()?.name || 'Same artwork'}</strong>
            <span>
              {props.group.cards.length} printings{props.artistName ? ` · ${props.artistName}` : ''}
            </span>
          </div>
          <button
            ref={(node) => { closeButton = node; }}
            type="button"
            class="artwork-pile-close"
            onClick={() => props.onClose()}
            aria-label="Close"
          >
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </button>
        </header>
        <div class="artwork-pile-row">
          <For each={orderedCards()}>
            {(card, index) => {
              const price = () => formatPkn(tilePricePkn(card));
              const identity = () => printingIdentity(card);
              return (
                <div
                  class="artwork-pile-card"
                  style={{ '--pile-i': index(), '--pile-tilt': index() % 2 ? '2.4deg' : '-2.4deg' }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <a
                    class="artwork-pile-frame"
                    href={cardHref(card)}
                    onClick={() => {
                      handOffCard(card);
                      rememberCardId(card);
                      track(Action.clickTile, card, { resultRank: index() });
                      props.onClose();
                    }}
                  >
                    <CardArt
                      src={imageSrc(card, 'hero')}
                      alt={cardImageAlt(card)}
                      full
                      card={card}
                      loading={index() < 6 ? 'eager' : 'lazy'}
                    />
                  </a>
                  <Show when={identity().tileLine}><em class="artwork-pile-line">{identity().tileLine}</em></Show>
                  <Show when={price()}><span class="artwork-pile-price">{price()}</span></Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}
