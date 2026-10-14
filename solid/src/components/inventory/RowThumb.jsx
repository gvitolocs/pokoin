import { Show } from 'solid-js';
import { homepageDerivativeUrl, ownCatalogImage, preferFullImage } from '@market/image-urls.js';

/**
 * Listing thumbnail (InventoryBoard / LocationBoard RowThumb): rows may carry a
 * stale or missing scan, so the catalog leftover image for the printing wins.
 */
export default function RowThumb(props) {
  const src = () => homepageDerivativeUrl(ownCatalogImage(
    { id: props.row?.cardId || props.row?.card_id },
    preferFullImage(props.row?.cardImageUrl || props.row?.card_image_url || ''),
  ));
  const name = () => props.row?.cardName || props.row?.name || 'Listing';
  return (
    <Show when={src()} fallback={<span class="inv-thumb is-empty" aria-hidden="true">{String(name()).slice(0, 1).toUpperCase()}</span>}>
      <img class="inv-thumb" src={src()} alt="" loading="lazy" width="40" height="56" />
    </Show>
  );
}

