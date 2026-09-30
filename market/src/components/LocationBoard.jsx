import { Link } from 'react-router-dom';
import {
  conditionChipSrc,
  conditionShort,
  conditionTone,
  listingLanguageFlag,
} from '../listing-meta.js';
import { homepageDerivativeUrl, ownCatalogImage, preferFullImage } from '../image-urls.js';
import { groupInventoryStacks } from '../inventory-listings.js';

function StackThumb({ row }) {
  const src = homepageDerivativeUrl(ownCatalogImage(
    { id: row?.cardId || row?.card_id },
    preferFullImage(row?.cardImageUrl || row?.card_image_url || ''),
  ));
  const name = row?.cardName || row?.name || 'Listing';
  if (src) {
    return <img className="inv-thumb" src={src} alt="" loading="lazy" width="40" height="56" />;
  }
  return <span className="inv-thumb is-empty" aria-hidden="true">{String(name).slice(0, 1).toUpperCase()}</span>;
}

function StackRow({ stack, formatPrice }) {
  const href = inventoryHref(stack);
  return (
    <div className="loc-stack">
      <div className="loc-stack-head">
        <Link className="inv-card" to={href}>
          <StackThumb row={stack} />
          <span className="inv-card-txt">
            <strong>{stack.cardName}</strong>
            <span className="inv-card-sub">
              {stack.setName}{stack.collectorNumber ? `${stack.setName ? ' · ' : ''}#${stack.collectorNumber}` : ''}
            </span>
          </span>
        </Link>
        <span className="loc-stack-meta">
          <img
            className={`shop-cond is-${conditionTone(stack.condition)}`}
            src={conditionChipSrc(stack.condition)}
            alt={conditionShort(stack.condition) || 'NM'}
            title={conditionShort(stack.condition) || 'NM'}
            width="34"
            height="24"
            loading="lazy"
          />
          {stack.language ? (() => {
            const language = listingLanguageFlag(stack.language);
            return language ? <img className="inv-flag" src={language.src} alt={language.code} width="18" height="18" loading="lazy" /> : null;
          })() : null}
          <span className="loc-count">
            <strong>{stack.postingCount}</strong>
            {' '}
            {stack.postingCount === 1 ? 'posting' : 'postings'}
            {' · '}
            {stack.copies} {stack.copies === 1 ? 'copy' : 'copies'}
          </span>
        </span>
      </div>
      <div className="loc-postings">
        {stack.postings.map((row) => (
          <Link key={row.id || `${row.cardId}-${row.pricePkn}`} className="loc-posting" to={href}>
            <span className="loc-posting-date">{row?.createdAt ? String(row.createdAt).slice(0, 10).split('-').reverse().join('/') : '—'}</span>
            <span className="inv-qty num">{Math.max(0, Number(row?.quantityAvailable ?? row?.quantity_available ?? 0) || 0)}×</span>
            <span className="inv-price num">{formatPrice(row?.pricePkn ?? row?.price_pkn)}</span>
            <span className={`inv-status ${String(row?.status || '').toLowerCase() === 'paused' ? 'is-paused' : 'is-live'}`}>
              {String(row?.status || 'active').toLowerCase() === 'paused' ? 'Paused' : 'Live'}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function inventoryHref(stack) {
  const id = String(stack.cardId || '');
  return /^\d+$/.test(id) ? `/marketplace/en/cards/${id}` : '/marketplace';
}

/** One bin/binder location: every card inside, grouped into stacks —
 * busiest stack (most postings) first. */
export default function LocationBoard({ rows, location, formatPrice }) {
  const stacks = groupInventoryStacks(rows);
  const postings = rows.length;
  const copies = stacks.reduce((sum, stack) => sum + stack.copies, 0);

  return (
    <section className="inv-board" aria-label={`Cards in ${location}`}>
      <div className="inv-summary">
        <div className="inv-stat"><strong>{stacks.length}</strong><span>Stacks</span></div>
        <div className="inv-stat"><strong>{postings}</strong><span>Postings</span></div>
        <div className="inv-stat is-gold"><strong>{copies}</strong><span>Copies</span></div>
      </div>

      {!stacks.length ? (
        <p className="inv-empty">Nothing stored in this location.</p>
      ) : (
        <div className="loc-list">
          {stacks.map((stack) => (
            <StackRow key={stack.key} stack={stack} formatPrice={formatPrice} />
          ))}
        </div>
      )}
    </section>
  );
}
