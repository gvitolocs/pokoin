import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatPkn } from '../api.js';
import { artCutVars } from '../art-cut.js';
import { listingReference, writeListingDrag } from '../chat-listing.js';
import { homepageDerivativeUrl, preferFullImage } from '../image-urls.js';
import ThumbZoom from './ThumbZoom.jsx';
import { openListingChat } from '../chat-dock-store.js';
import {
  conditionShort,
  conditionTone,
  listingExtraTags,
  listingLanguageFlag,
  publicShopSellerLabel,
  sellerCountryFlag,
  sellerHref,
} from '../listing-meta.js';
import { listingSelectId } from '../shop-marquee.js';

function ShopScan({ image, name, setName = '' }) {
  const full = preferFullImage(image) || image;
  const thumb = homepageDerivativeUrl(image) || image;
  return (
    <ThumbZoom src={full} full alt={name || ''}>
      <span className="art-cut shop-art" style={artCutVars({ set: setName, name })}>
        <img
          src={thumb}
          alt=""
          onError={(event) => {
            const img = event.currentTarget;
            if (img.dataset.fallback) return;
            img.dataset.fallback = '1';
            img.src = full;
          }}
        />
      </span>
    </ThumbZoom>
  );
}

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
  card = null,
  onBuy,
  onCart,
  onEdit,
  onCancel,
  selected = false,
}) {
  const [added, setAdded] = useState(false);
  const name = publicShopSellerLabel(offer);
  const stock = Math.max(0, Math.trunc(Number(offer?.quantityAvailable ?? offer?.quantity_available) || 0));
  const choices = Math.max(stock, 1);
  const [pick, setPick] = useState(1);
  const reference = {
    ...listingReference({ offer, card }),
    qty: showCard ? pick : 1,
    stock: choices,
  };
  const handle = reference.seller;
  const sellerUid = reference.sellerUid;
  const href = sellerHref(offer);
  const country = sellerCountryFlag(offer?.sellerCountry);
  const language = listingLanguageFlag(offer?.language);
  const tone = conditionTone(offer?.condition) || 'nm';
  const cond = conditionShort(offer?.condition);
  const tags = listingExtraTags(offer);
  const cardPath = offer?.canonicalPath || offer?.canonical_path || '';
  const cardName = offer?.cardName || offer?.name || '';
  const setName = offer?.setName || '';
  const image = offer?.cardImageUrl || offer?.imageUrl || '';

  function buy(event) {
    if (mine || !onBuy) return;
    if (event?.shiftKey || event?.ctrlKey || event?.metaKey) return;
    if (event?.target?.closest?.('a, button, select, .ct-qty')) return;
    onBuy(showCard ? pick : undefined);
  }

  return (
    <div
      className={`shop-row${mine ? ' mine' : ''}${showCard ? ' is-profile' : ''}${onBuy && !mine ? ' is-buy' : ''}${editing ? ' is-editing' : ''}${selected ? ' is-selected' : ''}`}
      data-listing-id={listingSelectId(offer)}
      draggable
      onDragStart={(event) => writeListingDrag(event, reference)}
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
            {image ? <ShopScan image={image} name={cardName} setName={setName} /> : <span className="shop-card-ph" />}
            <span>
              <strong>{cardName || 'Card'}</strong>
              {setName ? <em>{setName}</em> : null}
            </span>
          </Link>
        ) : (
          <span className="shop-card">
            {image ? <ShopScan image={image} name={cardName} setName={setName} /> : <span className="shop-card-ph" />}
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
      {showCard && !mine ? (
        <label className="ct-qty" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
          <select
            aria-label={`Quantity, ${Math.min(pick, choices)} of ${stock || choices}`}
            value={Math.min(pick, choices)}
            onChange={(event) => {
              event.stopPropagation();
              setPick(Number(event.target.value) || 1);
            }}
          >
            {Array.from({ length: choices }, (_, index) => {
              const n = index + 1;
              return <option key={n} value={n}>{n}</option>;
            })}
          </select>
          <span>of {stock || choices}</span>
        </label>
      ) : null}
      {!mine ? (
        <span className="shop-row-actions">
          {sellerUid ? (
            <button
              type="button"
              className="shop-icon"
              aria-label={handle ? `Message ${handle} about this listing` : 'Message this seller about this listing'}
              title="Message"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openListingChat(reference);
              }}
            >
              <MessageIcon />
            </button>
          ) : null}
          {onCart ? (
            <button
              type="button"
              className={`shop-icon is-cart${added ? ' is-added' : ''}`}
              aria-label={added ? 'Added to cart' : 'Add to cart'}
              title={added ? 'Added to cart' : 'Add to cart'}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onCart(showCard ? pick : undefined);
                setAdded(true);
              }}
            >
              <CartIcon />
            </button>
          ) : null}
        </span>
      ) : null}
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
        showCard ? null : <span className="shop-act">{choices}</span>
      )}
    </div>
  );
}

function MessageIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
    </svg>
  );
}

function CartIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path fill="currentColor" d="M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM6.2 6l.8 2h12.2l-1.6 6H8.1L6.2 6ZM5.2 4H2V2h4l.4 1H22l-2.4 9H7.5L5.2 4Z" />
    </svg>
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
