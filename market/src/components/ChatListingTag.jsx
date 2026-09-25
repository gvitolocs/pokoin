import { Link } from 'react-router-dom';
import { isSellerCard, tagKey } from '../chat-listing.js';
import { homepageDerivativeUrl, preferFullImage } from '../image-urls.js';

function fullImage(url) {
  return preferFullImage(url) || url || '';
}

export default function ChatListingTag({ row, onRemove }) {
  const label = row.cardName || 'Card';
  const stored = String(row.imageUrl || '').trim();
  const thumb = stored ? (homepageDerivativeUrl(stored) || stored) : '';
  const image = thumb ? (
    <img
      src={thumb}
      alt=""
      onError={(event) => {
        const img = event.currentTarget;
        if (img.dataset.fallback) return;
        const full = fullImage(stored);
        if (!full || img.getAttribute('src') === full) return;
        img.dataset.fallback = '1';
        img.src = full;
      }}
    />
  ) : <span className="chat-tag-ph" />;
  return (
    <span className={`chat-tag${isSellerCard(row) ? '' : ' is-trade'}`}>
      {row.path ? (
        <Link to={row.path} aria-label={label} onClick={(event) => event.stopPropagation()}>{image}</Link>
      ) : (
        <span className="chat-tag-body" role="img" aria-label={label}>{image}</span>
      )}
      {onRemove ? (
        <button type="button" aria-label={`Remove ${label}`} onClick={() => onRemove(tagKey(row))}>×</button>
      ) : null}
    </span>
  );
}
