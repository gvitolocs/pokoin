import { homepageDerivativeUrl, ownCatalogImage, preferFullImage } from '@market/image-urls.js';
import { MISSING_CARD_SRC } from '@market/missing-card.js';
import ScanImage from '../ScanImage.jsx';

/**
 * The thumbnail a row shows for its card: rows may carry a stale or missing
 * scan, so the catalog leftover image for the printing wins. Shared with Quick
 * Sell, whose dialog paints the same card in a slightly bigger box.
 */
export function rowThumbSrc(row) {
  const advertised = row?.cardImageUrl || row?.card_image_url || '';
  if (advertised === MISSING_CARD_SRC) return advertised;
  return homepageDerivativeUrl(ownCatalogImage(
    { id: row?.cardId || row?.card_id, name: row?.cardName || row?.name || '' },
    preferFullImage(advertised),
  ));
}

/**
 * Listing thumbnail (InventoryBoard / LocationBoard RowThumb): rows may carry a
 * stale or missing scan, so the catalog leftover image for the printing wins.
 */
export default function RowThumb(props) {
  const src = () => rowThumbSrc(props.row);
  const name = () => props.row?.cardName || props.row?.name || 'Listing';
  return (
    <ScanImage
      class="inv-thumb"
      letterClass="inv-thumb is-empty"
      src={src()}
      label={name()}
      width="40"
      height="56"
    />
  );
}

