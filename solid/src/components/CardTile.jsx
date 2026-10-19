import { Show } from 'solid-js';
import { isFeatureAlbumArt, isLandscapePrintName, resolveArtLayout } from '@market/art-cut.js';
import { albumShadeStyle } from '@market/art-shade.js';
import { cardHref, deskArtUrl, formatPkn, imageSrc, rememberCardId } from '@market/api.js';
import { cardReference, writeListingDrag } from '@market/chat-listing.js';
import { displayName, printingIdentity } from '@market/identity.js';
import { tileOfferPricePkn, tilePricePkn } from '@market/pkn.js';
import { cardImageAlt } from '@market/seo.js';
import { Action, track } from '@market/track.js';
import { handOffCard } from '../lib/card-handoff.js';
import { buyerParts, visitorParts } from '../stores/buyer.js';
import ArtworkZoom from './ArtworkZoom.jsx';
import CardArt from './CardArt.jsx';
import { useCardSelect } from './CardSelectGrid.jsx';
import PriceStack from './PriceStack.jsx';
import { gameHref } from '@market/game.js';

/**
 * Grid / rail / list tile. A plain anchor:
 * the router claims the click and intent-preloads the desk chunk + data on
 * hover, focus or touchstart. Inside a CardSelectGrid, Ctrl/Cmd/Shift-click
 * selects instead of opening, and dragging a selected tile carries the whole
 * selection. The list layout (set desk list view) zooms the full scan on hover.
 */
export default function CardTile(props) {
  const card = () => props.card;
  const cut = () => Boolean(props.cut);
  const list = () => props.layout === 'list';
  const pricePkn = () => tilePricePkn(card());
  const price = () => formatPkn(pricePkn());
  const identity = () => printingIdentity(card());
  const landscape = () => cut() && isLandscapePrintName(card().name);
  const artLayout = () => (cut() ? resolveArtLayout(card()) : 'window');
  const item = () => cut() && artLayout() === 'item';
  const tall = () => cut() && !landscape() && isFeatureAlbumArt(card());
  const hero = () => imageSrc(card(), 'hero');
  const art = () => (cut() ? hero() : imageSrc(card(), list() ? 'hero' : 'grid'));
  const eagerLimit = () => props.eagerLimit ?? 8;
  const eager = () => eagerLimit() > 0 && props.rank != null && props.rank < eagerLimit();
  const select = useCardSelect();
  const picked = () => Boolean(select?.isSelected(card()?.id));

  let warmed = false;
  function prepare() {
    handOffCard(card());
    if (warmed) return;
    warmed = true;
    // The exact URL the desk scan asks for, so the desk reuses this download.
    const url = deskArtUrl(card());
    if (url) {
      const img = new Image();
      img.src = url;
    }
  }

  // `currency` pins the label to one local fiat (the public landing shows the visitor's currency).
  const parts = () => (props.currency ? visitorParts(pricePkn(), props.currency) : buyerParts(pricePkn()));
  // The tile price is the lowest ask across marketplaces, not a Pokoin offer
  // ("from" read as buyable here): the tooltip says which number it is.
  const fromOffer = () => tileOfferPricePkn(card()) != null;
  const priceTitle = () => (fromOffer() ? 'Lowest price listed across marketplaces' : 'Median sold price');
  const priceLabel = () => (price() ? <PriceStack parts={parts()} /> : 'Out of stock');

  return (
    <Show when={card()?.id}>
      <a
        class={[
          list() ? 'tile tile-row' : 'tile',
          {
            'tile-cut tile-album': cut(),
            'tile-tall': tall(),
            'tile-item': item(),
            'is-landscape': landscape(),
            'is-selected': picked(),
          },
        ]}
        href={gameHref(cardHref(card()))}
        data-card-id={card().id}
        aria-selected={picked() ? 'true' : undefined}
        draggable="true"
        onDragStart={(event) => writeListingDrag(event, select?.dragPayload(card()) || cardReference(card()))}
        onClick={(event) => {
          if (select && (event.metaKey || event.ctrlKey || event.shiftKey)) {
            event.preventDefault();
            select.click(card().id, event);
            return;
          }
          handOffCard(card());
          rememberCardId(card());
          track(props.action || Action.clickTile, card(), { resultRank: props.rank });
        }}
        onPointerEnter={prepare}
        onFocus={prepare}
        style={cut() ? albumShadeStyle(card()) : undefined}
      >
        <span class="tile-art">
          <Show when={art()} fallback={<span class="tile-ph" />}>
            <Show
              when={list()}
              fallback={(
                <CardArt
                  src={art()}
                  alt={cardImageAlt(card())}
                  cut={cut() && !landscape() && !item()}
                  cutSurface="album"
                  full={cut()}
                  card={cut() ? card() : undefined}
                  loading={eager() ? 'eager' : 'lazy'}
                  fetchPriority={props.artPriority || (eager() && props.rank < Math.min(4, eagerLimit()) ? 'high' : undefined)}
                />
              )}
            >
              <ArtworkZoom
                src={hero() || art()}
                name={card().name}
                set={card().set || card().expansion || ''}
                alt={cardImageAlt(card())}
              />
            </Show>
          </Show>
        </span>
        <Show
          when={!cut()}
          fallback={(
            <div class="tile-meta">
              <Show when={identity().tileLine}><em class="tile-id">{identity().tileLine}</em></Show>
            </div>
          )}
        >
          <div class="tile-meta">
            <strong>{displayName(card())}</strong>
            <Show when={identity().tileLine}><em class="tile-id">{identity().tileLine}</em></Show>
            <Show when={!list()}>
              <span class={price() ? 'price' : 'oos'} title={price() ? priceTitle() : undefined}>{priceLabel()}</span>
            </Show>
          </div>
        </Show>
        <Show when={list() && !cut()}>
          <span class={price() ? 'price' : 'oos'} title={price() ? priceTitle() : undefined}>{priceLabel()}</span>
        </Show>
      </a>
    </Show>
  );
}
