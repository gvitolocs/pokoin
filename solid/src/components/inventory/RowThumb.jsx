import { homepageDerivativeUrl, ownCatalogImage, preferFullImage } from '@market/image-urls.js';
import ScanImage from '../ScanImage.jsx';

/**
 * Listing thumbnail (InventoryBoard / LocationBoard RowThumb): rows may carry a
 * stale or missing scan, so the catalog leftover image for the printing wins.
 */
export default function RowThumb(props) {
  const src = () => homepageDerivativeUrl(ownCatalogImage(
    { id: props.row?.cardId || props.row?.card_id, name: props.row?.cardName || props.row?.name || '' },
    preferFullImage(props.row?.cardImageUrl || props.row?.card_image_url || ''),
  ));
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

