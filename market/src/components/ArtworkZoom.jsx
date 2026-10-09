import { artCutVars } from '../art-cut.js';
import { cdnFetchUrl, homepageDerivativeUrl, preferFullImage } from '../image-urls.js';
import ThumbZoom from './ThumbZoom.jsx';

/**
 * Illustration window in the row. Hover floats the full scan at the shared
 * shop/cart size, not the smaller chat-tile zoom.
 */
export default function ArtworkZoom({ src, name = '', set = '', alt = '' }) {
  const full = preferFullImage(src) || src;
  const thumb = homepageDerivativeUrl(src) || full;
  if (!full) return null;
  return (
    <ThumbZoom src={full} full alt={alt || name}>
      <span className="art-cut" style={artCutVars({ name, set, expansion: set }, 'album')}>
        <img
          src={cdnFetchUrl(thumb)}
          alt=""
          draggable={false}
          onError={(event) => {
            const img = event.currentTarget;
            if (!img || img.dataset.fallback) return;
            img.dataset.fallback = '1';
            img.src = cdnFetchUrl(full);
          }}
        />
      </span>
    </ThumbZoom>
  );
}
