import { Link } from 'react-router-dom';
import { tagKey } from '../chat-listing.js';

export default function ChatListingTag({ row, onRemove }) {
  const label = row.cardName || 'Card';
  const image = row.imageUrl ? <img src={row.imageUrl} alt="" /> : <span className="chat-tag-ph" />;
  return (
    <span className="chat-tag">
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
