import { Show } from 'solid-js';
import { looseCardReference, writeListingDrag } from '@market/chat-listing.js';
import { homepageDerivativeUrl, ownCatalogImage, preferFullImage } from '@market/image-urls.js';
import { goMarket } from '@market/punchouts.js';
import ThumbZoom from './ThumbZoom.jsx';

/**
 * One card in a dashboard miniature sheet (market/src/components/MiniCardTile.jsx):
 * the 240px `_homepage.webp` thumbnail, falling back to the full art; hover
 * floats the full card beside the cursor. `badge` marks quantity.
 */
export default function MiniCardTile(props) {
  const name = () => props.name || 'Card';
  const full = () => ownCatalogImage(
    { id: props.cardId || '', name: name(), canonicalPath: props.href || '' },
    preferFullImage(props.imageUrl || ''),
  );
  const thumb = () => (full() ? homepageDerivativeUrl(full()) || full() : '');
  const onDragStart = (event) => writeListingDrag(event, looseCardReference({
    imageUrl: full(),
    name: name(),
    href: props.href || '',
    cardId: props.cardId || '',
    sellerUid: props.sellerUid || '',
    seller: props.seller || '',
    pricePkn: props.pricePkn || 0,
    listingId: props.listingId || '',
  }));
  const art = () => (
    <span class="seller-listing-art">
      <Show when={thumb()} fallback={<span class="tile-ph" aria-hidden="true" />}>
        <ThumbZoom src={full()} full alt={name()}>
          <img
            src={thumb()}
            alt=""
            loading="lazy"
            decoding="async"
            onError={(event) => {
              const img = event.currentTarget;
              if (img.dataset.fallback) return;
              img.dataset.fallback = '1';
              img.src = full();
            }}
          />
        </ThumbZoom>
      </Show>
      <Show when={props.badge}><span class="seller-listing-badge">{props.badge}</span></Show>
    </span>
  );
  const label = () => props.title || name();
  return (
    <Show
      when={props.href}
      fallback={<span class="seller-listing-tile" title={label()} aria-label={name()} draggable={true} onDragStart={onDragStart}>{art()}</span>}
    >
      <a
        class="seller-listing-tile"
        href={props.href}
        title={label()}
        aria-label={name()}
        draggable={true}
        onDragStart={onDragStart}
        onClick={(event) => {
          if (!String(props.href).startsWith('http')) return;
          event.preventDefault();
          goMarket(props.href);
        }}
      >
        {art()}
      </a>
    </Show>
  );
}
