import { Link } from 'react-router-dom';
import { looseCardReference, writeListingDrag } from '../chat-listing.js';
import { homepageDerivativeUrl } from '../image-urls.js';
import { goMarket } from '../punchouts.js';
import ThumbZoom from './ThumbZoom.jsx';

/**
 * One card in a dashboard miniature sheet (Your listings, CardTrader 1-DR):
 * the 240px `_homepage.webp` thumbnail, falling back to the full art when a
 * card has no thumbnail. Hovering floats the full card beside the cursor, as
 * on the scan desk. `badge` marks quantity; the title carries details.
 */
export default function MiniCardTile({
  imageUrl = '', name = 'Card', title = '', href = '', badge = '', cardId = '', sellerUid = '', seller = '', pricePkn = 0, listingId = '',
}) {
  const full = String(imageUrl || '').trim();
  const thumb = full ? homepageDerivativeUrl(full) || full : '';
  const drag = {
    draggable: true,
    onDragStart: (event) => writeListingDrag(event, looseCardReference({
      imageUrl: full, name, href, cardId, sellerUid, seller, pricePkn, listingId,
    })),
  };
  const art = (
    <span className="seller-listing-art">
      {thumb ? (
        <ThumbZoom src={full} full alt={name}>
          <img
            src={thumb}
            alt=""
            loading="lazy"
            decoding="async"
            onError={(event) => {
              const img = event.currentTarget;
              if (img.dataset.fallback) return;
              img.dataset.fallback = '1';
              img.src = full;
            }}
          />
        </ThumbZoom>
      ) : <span className="tile-ph" aria-hidden="true" />}
      {badge ? <span className="seller-listing-badge">{badge}</span> : null}
    </span>
  );
  const label = title || name;
  if (!href) {
    return <span className="seller-listing-tile" title={label} aria-label={name} {...drag}>{art}</span>;
  }
  if (href.startsWith('http')) {
    return (
      <a
        className="seller-listing-tile"
        href={href}
        title={label}
        aria-label={name}
        {...drag}
        onClick={(event) => {
          event.preventDefault();
          goMarket(href);
        }}
      >
        {art}
      </a>
    );
  }
  return <Link className="seller-listing-tile" to={href} title={label} aria-label={name} {...drag}>{art}</Link>;
}
