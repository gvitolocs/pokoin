import { Link } from 'react-router-dom';
import { formatPkn } from '../api.js';
import {
  conditionShort,
  conditionTone,
  listingExtraTags,
  listingLanguageFlag,
  sellerCountryFlag,
  sellerHref,
} from '../listing-meta.js';

function Flag({ flag, className }) {
  if (!flag) return null;
  return (
    <img
      className={className}
      src={flag.src}
      alt={flag.label}
      title={flag.label}
      width="18"
      height="18"
    />
  );
}

export default function ShopListingRow({
  offer,
  mine = false,
  showCard = false,
  listingBusy = false,
  editing = false,
  onBuy,
  onEdit,
  onCancel,
}) {
  const name = String(offer?.sellerName || offer?.sellerDisplayName || 'Pokoin');
  const href = sellerHref(offer);
  const country = sellerCountryFlag(offer?.sellerCountry);
  const language = listingLanguageFlag(offer?.language);
  const tone = conditionTone(offer?.condition) || 'nm';
  const cond = conditionShort(offer?.condition);
  const tags = listingExtraTags(offer);
  const qty = offer?.quantityAvailable || 1;
  const cardPath = offer?.canonicalPath || offer?.canonical_path || '';
  const cardName = offer?.cardName || offer?.name || '';
  const setName = offer?.setName || '';
  const image = offer?.cardImageUrl || offer?.imageUrl || '';

  function buy(event) {
    if (mine || !onBuy) return;
    if (event?.target?.closest?.('a, button')) return;
    onBuy();
  }

  return (
    <div
      className={`shop-row${mine ? ' mine' : ''}${showCard ? ' is-profile' : ''}${onBuy && !mine ? ' is-buy' : ''}${editing ? ' is-editing' : ''}`}
      onClick={buy}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          buy(event);
        }
      }}
      role={onBuy && !mine ? 'button' : undefined}
      tabIndex={onBuy && !mine ? 0 : undefined}
    >
      {showCard ? (
        cardPath ? (
          <Link className="shop-card" to={cardPath} onClick={(event) => event.stopPropagation()}>
            {image ? <img src={image} alt="" /> : <span className="shop-card-ph" />}
            <span>
              <strong>{cardName || 'Card'}</strong>
              {setName ? <em>{setName}</em> : null}
            </span>
          </Link>
        ) : (
          <span className="shop-card">
            {image ? <img src={image} alt="" /> : <span className="shop-card-ph" />}
            <span>
              <strong>{cardName || 'Card'}</strong>
              {setName ? <em>{setName}</em> : null}
            </span>
          </span>
        )
      ) : href ? (
        <Link className="shop-seller" to={href} state={{ listing: offer }} onClick={(event) => event.stopPropagation()}>
          <Flag flag={country} className="shop-flag shop-flag-country" />
          <span className="shop-brand">{name}</span>
        </Link>
      ) : (
        <span className="shop-seller">
          <Flag flag={country} className="shop-flag shop-flag-country" />
          <span className="shop-brand">{name}</span>
        </span>
      )}
      <span className={`shop-cond is-${tone}`}>{cond}</span>
      <Flag flag={language} className="shop-flag shop-flag-lang" />
      <span className="shop-txt">
        {tags.map((tag) => (
          <em key={tag} className="meta-chip">{tag}</em>
        ))}
      </span>
      <span className="shop-px">{formatPkn(offer.pricePkn) || '—'}</span>
      {mine ? (
        <span className="shop-owner-actions">
          <button
            type="button"
            className={`icon-btn shop-edit${editing ? ' on' : ''}`}
            disabled={listingBusy}
            title={editing ? 'Editing this listing' : 'Edit listing'}
            aria-label={editing ? 'Editing this listing' : 'Edit listing'}
            aria-pressed={editing}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onEdit?.();
            }}
          >
            <EditIcon />
          </button>
          <button
            type="button"
            className="icon-btn shop-trash"
            disabled={listingBusy}
            title="Cancel listing"
            aria-label="Cancel listing"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onCancel?.();
            }}
          >
            <TrashIcon />
          </button>
        </span>
      ) : (
        <span className="shop-act">{qty}</span>
      )}
    </div>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
      />
    </svg>
  );
}
