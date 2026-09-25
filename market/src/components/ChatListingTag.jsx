import { Link } from 'react-router-dom';
import { tagKey } from '../chat-listing.js';

export default function ChatListingTag({ row, onRemove }) {
  const body = (
    <>
      {row.imageUrl ? <img src={row.imageUrl} alt="" /> : <span className="chat-tag-ph" />}
      <span>
        <strong>{row.cardName}</strong>
        {row.pricePkn ? <em>{row.pricePkn} PKN</em> : null}
      </span>
    </>
  );
  return (
    <span className="chat-tag">
      {row.path ? <Link to={row.path} onClick={(event) => event.stopPropagation()}>{body}</Link> : <span className="chat-tag-body">{body}</span>}
      {onRemove ? (
        <button type="button" aria-label={`Remove ${row.cardName}`} onClick={() => onRemove(tagKey(row))}>×</button>
      ) : null}
    </span>
  );
}
