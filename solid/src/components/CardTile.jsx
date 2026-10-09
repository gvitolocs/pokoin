import { Show } from 'solid-js';
import { isFeatureAlbumArt, isLandscapePrintName, resolveArtLayout } from '@market/art-cut.js';
import { albumShadeStyle } from '@market/art-shade.js';
import { cardHref, formatPkn, imageSrc, rememberCardId } from '@market/api.js';
import { cardReference, writeListingDrag } from '@market/chat-listing.js';
import { displayName, printingIdentity } from '@market/identity.js';
import { cdnFetchUrl } from '@market/image-urls.js';
import { tilePricePkn } from '@market/pkn.js';
import { cardImageAlt } from '@market/seo.js';
import { Action, track } from '@market/track.js';
import { handOffCard } from '../lib/card-handoff.js';
import { buyerParts } from '../stores/buyer.js';
import CardArt from './CardArt.jsx';
import PriceStack from './PriceStack.jsx';

/**
 * Grid / rail / list tile (market/src/components/CardTile.jsx). A plain anchor:
 * the router claims the click and intent-preloads the desk chunk + data on
 * hover, focus or touchstart. Not ported yet: multi-select (CardSelectGrid)
 * and the list layout's ArtworkZoom, which falls back to CardArt here.
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

  let warmed = false;
  function prepare() {
    handOffCard(card());
    if (warmed) return;
    warmed = true;
    if (hero()) {
      const img = new Image();
      img.src = cdnFetchUrl(hero());
    }
  }

  const priceLabel = () => (price() ? <PriceStack parts={buyerParts(pricePkn())} /> : 'Out of stock');

  return (
    <Show when={card()?.id}>
      <a
        class={[
          list() ? 'tile tile-row' : 'tile',
          { 'tile-cut tile-album': cut(), 'tile-tall': tall(), 'tile-item': item(), 'is-landscape': landscape() },
        ]}
        href={cardHref(card())}
        data-card-id={card().id}
        draggable="true"
        onDragStart={(event) => writeListingDrag(event, cardReference(card()))}
        onClick={() => {
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
            <CardArt
              src={art()}
              alt={cardImageAlt(card())}
              cut={cut() && !landscape() && !item()}
              cutSurface="album"
              full={cut() || list()}
              card={cut() ? card() : undefined}
              loading={eager() ? 'eager' : 'lazy'}
              fetchPriority={eager() && props.rank < Math.min(4, eagerLimit()) ? 'high' : undefined}
            />
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
              <span class={price() ? 'price' : 'oos'}>{priceLabel()}</span>
            </Show>
          </div>
        </Show>
        <Show when={list() && !cut()}>
          <span class={price() ? 'price' : 'oos'}>{priceLabel()}</span>
        </Show>
      </a>
    </Show>
  );
}
