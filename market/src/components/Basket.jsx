// Amazon-layout cart pieces: big price, basket row, seller parcel bar,
// "Important messages", the Subtotal box and the Flex card (Prime's slot).

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { brandSrc } from '../brand-assets.js';
import { isSelected, priceDrop } from '../cart-model.js';
import { listingStock } from '../cart-qty.js';
import { looseCardReference, writeListingDrag } from '../chat-listing.js';
import { gameBasename } from '../game.js';
import { printingIdentity } from '../identity.js';
import { homepageDerivativeUrl } from '../image-urls.js';
import { authFrom } from '../punchouts.js';
import {
  conditionChipSrc,
  conditionShort,
  conditionTone,
  listingExtraTags,
  listingLanguageFlag,
  publicShopSellerLabel,
  sellerCountryFlag,
  sellerCountryLabel,
  sellerHref,
} from '../listing-meta.js';
import { fiatFromPkn, formatLocalFromEurCents, formatPkn, formatPknNumber } from '../pkn.js';
import { shipFromCountryName } from '../ship-countries.js';
import { useBuyerCurrency } from '../use-buyer-currency.js';
import CardArt from './CardArt.jsx';

const LOW_STOCK = 3;

function fiatParts(pricePkn, currency) {
  const amount = fiatFromPkn(pricePkn, currency);
  if (amount == null) return null;
  const [int, dec] = amount.toFixed(2).split('.');
  if (currency === 'DKK') return { pre: '', int, dec, post: 'DKK' };
  if (currency === 'USD') return { pre: '$', int, dec, post: '' };
  return { pre: '€', int, dec, post: '' };
}

/**
 * Amazon's price: small symbol, big whole part, small raised cents. PKN stays
 * digits only (2642 PKN, never 2,642); local currency shows the PKN under it.
 */
export function BigPrice({ pricePkn, sellerAcceptsPkn = true, size = 'lg', fiat }) {
  const buyer = useBuyerCurrency();
  const pkn = Number(pricePkn) || 0;
  if (!(pkn > 0)) return <span className="bk-price is-none">—</span>;
  const local = (fiat ?? buyer.fiat(pkn, sellerAcceptsPkn)) ? fiatParts(pkn, buyer.currency) : null;
  if (local) {
    return (
      <span className={`bk-price is-${size}`}>
        <span className="bk-price-main">
          {local.pre ? <span className="bk-price-sym">{local.pre}</span> : null}
          <span className="bk-price-int">{local.int}</span>
          <span className="bk-price-dec">{local.dec}</span>
          {local.post ? <span className="bk-price-sym is-post">{local.post}</span> : null}
        </span>
        <span className="bk-price-sub">{formatPkn(pkn)}</span>
      </span>
    );
  }
  const [int, dec] = formatPknNumber(pkn).split('.');
  return (
    <span className={`bk-price is-${size}`}>
      <span className="bk-price-main">
        <span className="bk-price-int">{int}</span>
        {dec ? <span className="bk-price-dec">{dec}</span> : null}
        <span className="bk-price-sym is-post">PKN</span>
      </span>
    </span>
  );
}

function Flag({ flag }) {
  if (!flag) return null;
  if (flag.src) {
    return <img className="bk-flag" src={flag.src} alt="" title={flag.label} width="16" height="16" />;
  }
  return flag.emoji ? <span className="bk-flag is-emoji" aria-hidden="true">{flag.emoji}</span> : null;
}

export function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" d="M4 7h16M9 7V4h6v3m-8.5 0 .8 13h9.4l.8-13M10 11v6m4-6v6" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" d="M5 12h14" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function InfoIcon() {
  return (
    <svg className="bk-info-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="currentColor" />
      <rect x="10.8" y="10" width="2.4" height="7" rx="1.1" fill="#111" />
      <circle cx="12" cy="6.8" r="1.5" fill="#111" />
    </svg>
  );
}

/** Amazon's pill: trash at 1, minus above; plus stops at the seller's stock. */
export function QtyPill({ qty, max, name, onChange, onDelete }) {
  const value = Math.max(1, Math.trunc(Number(qty) || 1));
  const cap = Math.max(1, Math.trunc(Number(max) || 1));
  const last = value <= 1;
  return (
    <div className="bk-stepper" role="group" aria-label={`Quantity of ${name}`}>
      <button
        type="button"
        className="bk-step"
        aria-label={last ? `Delete ${name}` : 'Decrease quantity'}
        title={last ? 'Delete' : 'Decrease'}
        onClick={() => (last ? onDelete() : onChange(value - 1))}
      >
        {last ? <TrashIcon /> : <MinusIcon />}
      </button>
      <span className="bk-q" aria-live="polite">{value}</span>
      <button
        type="button"
        className="bk-step"
        aria-label="Increase quantity"
        title={value >= cap ? `Only ${cap} available` : 'Increase'}
        disabled={value >= cap}
        onClick={() => onChange(value + 1)}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

async function shareLink(row) {
  const url = new URL(`${gameBasename()}${row.href || '/marketplace'}`, window.location.origin).href;
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: row.name, url });
      return 'Shared';
    } catch (err) {
      if (err?.name === 'AbortError') return '';
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'Link copied';
  } catch (_) {
    return '';
  }
}

function sellerOf(offer) {
  return publicShopSellerLabel(offer) || offer?.sellerName || 'Pokoin';
}

/** One basket line: tick, scan, details + actions, price column. */
export function BasketRow({ row, live, checking, onSelect, onQty, onDelete, onSave, onSwap }) {
  const buyer = useBuyerCurrency();
  const [shared, setShared] = useState('');
  const gone = Boolean(row.unavailable) || live?.status === 'gone';
  const selected = isSelected(row) && !gone;
  const qty = Math.max(1, Math.trunc(Number(row.qty) || 1));
  const cap = listingStock(row);
  const drop = priceDrop(row);
  const href = row.href || '/marketplace';
  const seller = sellerOf(row);
  const sellerLink = sellerHref(row);
  const country = sellerCountryFlag(row.sellerCountry);
  const countryName = sellerCountryLabel(row.sellerCountry);
  const language = listingLanguageFlag(row.language);
  const tone = conditionTone(row.condition) || 'nm';
  const tags = listingExtraTags({ ...row, reserveAvailable: false, nftAvailable: false });
  const stock = live?.status === 'ok' ? live.stock : null;
  const cheaper = live?.cheaper || null;
  const accepts = row.sellerAcceptsPkn !== false;
  const setLine = printingIdentity({
    id: row.cardId,
    set: row.setName,
    number: row.collectorNumber,
    imageUrl: row.image,
  }).tileLine;

  async function share() {
    const result = await shareLink(row);
    setShared(result);
    if (result) window.setTimeout(() => setShared(''), 2200);
  }

  let stockLine = null;
  if (gone) {
    stockLine = <div className="bk-stock is-gone">Currently unavailable. This copy sold or the seller took it down.</div>;
  } else if (stock != null && stock <= LOW_STOCK) {
    stockLine = <div className="bk-stock is-low">Only {stock} left from this seller.</div>;
  } else if (stock != null) {
    stockLine = <div className="bk-stock">In stock</div>;
  } else if (checking) {
    stockLine = <div className="bk-stock is-checking">Checking stock…</div>;
  }

  return (
    <article className={`bk-row${gone ? ' is-gone' : ''}${selected ? '' : ' is-off'}`} data-row-id={row.id}>
      <label className="bk-check">
        <input
          type="checkbox"
          aria-label={`Buy ${row.name} at checkout`}
          checked={selected}
          disabled={gone}
          onChange={(event) => onSelect(event.target.checked)}
        />
      </label>
      <Link
        className="bk-pic"
        to={href}
        draggable
        onDragStart={(event) => writeListingDrag(event, looseCardReference({
          imageUrl: row.image, name: row.name, href: row.href, cardId: row.cardId,
          sellerUid: row.sellerUid, pricePkn: row.pricePkn, listingId: row.listingId,
        }))}
      >
        {row.image
          ? <CardArt src={homepageDerivativeUrl(row.image) || row.image} alt={row.name} loading="lazy" />
          : <span className="bk-pic-ph" />}
      </Link>
      <div className="bk-head">
        <Link className="bk-title" to={href}>{row.name}</Link>
        {setLine ? <div className="bk-set">{setLine}</div> : null}
      </div>
      <div className="bk-body">
        {stockLine}
        <div className="bk-ship">
          Sold by{' '}
          {sellerLink ? <Link className="bk-link" to={sellerLink}>{seller}</Link> : <span>{seller}</span>}
          {countryName ? (
            <>
              {' · ships from '}
              <Flag flag={country} />
              {' '}
              {countryName}
            </>
          ) : null}
        </div>
        <div className="bk-variant">
          <span>
            <b>Condition: </b>
            <img
              className={`bk-cond is-${tone}`}
              src={conditionChipSrc(row.condition)}
              alt=""
              width="30"
              height="21"
            />
            {' '}
            {conditionShort(row.condition)}
          </span>
          {language ? (
            <span>
              <b>Language: </b>
              <Flag flag={language} />
              {' '}
              {language.label}
            </span>
          ) : null}
          {tags.map((tag) => <em key={tag} className="bk-tag">{tag}</em>)}
        </div>
        {row.nftAvailable || row.reserveAvailable ? (
          <div className="bk-digital">
            Digital checkout available: the card can go straight into your collection, nothing is mailed.
          </div>
        ) : null}
        <div className="bk-actions">
          {gone ? (
            <button type="button" className="bk-btn-o is-small" onClick={onDelete}>Delete</button>
          ) : (
            <>
              <QtyPill qty={qty} max={cap} name={row.name} onChange={onQty} onDelete={onDelete} />
              <span className="bk-div" aria-hidden="true" />
              <button type="button" className="bk-link" onClick={onDelete}>Delete</button>
            </>
          )}
          <span className="bk-div" aria-hidden="true" />
          <button type="button" className="bk-link" onClick={onSave}>Save for later</button>
          <span className="bk-div" aria-hidden="true" />
          <button type="button" className="bk-link" onClick={share} aria-live="polite">{shared || 'Share'}</button>
        </div>
        {gone ? (
          <div className="bk-offer is-gone">
            {cheaper ? (
              <>
                Another {conditionShort(cheaper.condition)} copy is {buyer.format(cheaper.pricePkn, cheaper.sellerAcceptsPkn)} from {sellerOf(cheaper)}.{' '}
                <button type="button" className="bk-link" onClick={() => onSwap(cheaper)}>Replace it</button>
              </>
            ) : (
              <>
                No other copy in this condition and language right now.{' '}
                <Link className="bk-link" to={href}>See all offers</Link>
              </>
            )}
          </div>
        ) : cheaper ? (
          <div className="bk-offer">
            <span className="bk-save-badge">
              Save {Math.max(1, Math.round((1 - Number(cheaper.pricePkn) / Number(row.pricePkn)) * 100))}%
            </span>
            {' '}Same card, condition and language for {buyer.format(cheaper.pricePkn, cheaper.sellerAcceptsPkn)} from {sellerOf(cheaper)}.{' '}
            <button type="button" className="bk-link" onClick={() => onSwap(cheaper)}>Swap to it</button>
          </div>
        ) : null}
      </div>
      <div className="bk-prc">
        {drop ? <div className="bk-deal-label">Price drop</div> : null}
        <div className="bk-deal-row">
          {drop ? <span className="bk-deal-badge">-{drop.percent}%</span> : null}
          <BigPrice pricePkn={row.pricePkn} sellerAcceptsPkn={accepts} />
        </div>
        {qty > 1 ? (
          <div className="bk-unit">{qty} copies · {buyer.format(Number(row.pricePkn) * qty, accepts)}</div>
        ) : null}
        {drop ? (
          <div className="bk-was">Was: <s>{buyer.format(drop.was, accepts)}</s></div>
        ) : null}
        {accepts ? null : (
          <div className="bk-promo"><span className="bk-save-badge is-muted">Card only</span> pay by card</div>
        )}
        {sellerLink ? <Link className="bk-link bk-shop" to={sellerLink}>Shop this seller</Link> : null}
      </div>
    </article>
  );
}

/** Seller strip above that seller's rows: one parcel, its preview price and room. */
export function SellerBar({ group, estimate, currency }) {
  const label = sellerOf({ sellerUsername: group.sellerUsername, sellerName: group.sellerName });
  const link = sellerHref({ sellerUsername: group.sellerUsername, sellerName: group.sellerName });
  const country = sellerCountryFlag(group.sellerCountry);
  const countryName = sellerCountryLabel(group.sellerCountry);
  return (
    <div className="bk-seller-bar">
      <span className="bk-seller-name">
        Parcel from {link ? <Link className="bk-link" to={link}>{label}</Link> : label}
        {countryName ? (
          <>
            {' · '}
            <Flag flag={country} />
            {' '}
            {countryName}
          </>
        ) : null}
      </span>
      <span className="bk-parcel">
        {!group.selectedCount
          ? 'Nothing ticked from this seller'
          : estimate
            ? (
              <>
                {estimate.serviceName || 'Shipping'} {formatLocalFromEurCents(estimate.amountCents, currency)}
                {estimate.room > 0 ? ` · room for ${estimate.room} more card${estimate.room === 1 ? '' : 's'} at this price` : ''}
              </>
            )
            : 'Shipping quoted at checkout'}
      </span>
    </div>
  );
}

const MESSAGE_TEXT = {
  price_up: (note, fmt) => `The price of ${note.name} from ${sellerOf(note)} went up from ${fmt(note.from)} to ${fmt(note.to)}.`,
  price_down: (note, fmt) => `${note.name} from ${sellerOf(note)} dropped from ${fmt(note.from)} to ${fmt(note.to)}.`,
  qty: (note) => `${sellerOf(note)} has only ${note.to} of ${note.name} left, so the quantity went from ${note.from} to ${note.to}.`,
  gone: (note) => `${note.name} from ${sellerOf(note)} is no longer available. It is unticked and stays below until you delete it.`,
};

/** Amazon's "Important messages about items in your basket". */
export function ImportantMessages({ messages, onDismiss }) {
  const buyer = useBuyerCurrency();
  if (!messages?.length) return null;
  const fmt = (pkn) => buyer.format(pkn);
  return (
    <div className="bk-messages" role="status">
      <h2>Important messages about items in your cart</h2>
      <ul>
        {messages.map((note) => (
          <li key={note.id} className={`is-${note.kind}`}>
            <span>{(MESSAGE_TEXT[note.kind] || (() => ''))(note, fmt)}</span>
            <button type="button" className="bk-x" aria-label="Dismiss" onClick={() => onDismiss(note.id)}>×</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "€3.13" bold with "626 PKN" under it, or just "626 PKN" when the balance pays. */
export function SubtotalAmount({ pricePkn }) {
  const buyer = useBuyerCurrency();
  const pkn = Number(pricePkn) || 0;
  if (!(pkn > 0)) return <b className="bk-sub-amt">0 PKN</b>;
  const parts = buyer.parts(pkn);
  return (
    <span className="bk-sub-amt">
      <b>{parts.local || parts.pkn}</b>
      {parts.local ? <span className="bk-sub-pkn">{parts.pkn}</span> : null}
    </span>
  );
}

/** Right-rail box: parcel nudge, Subtotal, shipping and balance lines, gift, checkout. */
export function BasketSummary({
  totals,
  shipping,
  nudge,
  delivery,
  currency,
  signedIn,
  availablePkn,
  gift,
  onGift,
}) {
  const buyer = useBuyerCurrency();
  const n = totals.selectedCount;
  const subtotal = totals.selectedSubtotalPkn;
  const covered = signedIn && Number(availablePkn) >= subtotal && subtotal > 0;
  const nudgeLabel = nudge
    ? sellerOf({ sellerUsername: nudge.group.sellerUsername, sellerName: nudge.group.sellerName })
    : '';
  const nudgeLink = nudge
    ? sellerHref({ sellerUsername: nudge.group.sellerUsername, sellerName: nudge.group.sellerName })
    : '';
  const deliveryName = shipFromCountryName(delivery.country) || delivery.country;
  return (
    <div className="bk-card bk-summary">
      {nudge ? (
        <div className="bk-note">
          <InfoIcon />
          <p>
            Add up to <span className="bk-red">{nudge.estimate.room} more card{nudge.estimate.room === 1 ? '' : 's'}</span> from{' '}
            {nudgeLink ? <Link className="bk-link" to={nudgeLink}>{nudgeLabel}</Link> : nudgeLabel} to the same parcel: shipping stays{' '}
            <b>{formatLocalFromEurCents(nudge.estimate.amountCents, currency)}</b>.{' '}
            <Link className="bk-link" to="/flex">Shipping details</Link>
          </p>
        </div>
      ) : null}
      <div className="bk-subtotal">
        Subtotal ({n} {n === 1 ? 'item' : 'items'}): <SubtotalAmount pricePkn={subtotal} />
      </div>
      <dl className="bk-sum-lines">
        <div>
          <dt>
            Shipping to {deliveryName}
            {shipping.count ? ` · ${shipping.count} parcel${shipping.count === 1 ? '' : 's'}` : ''}
          </dt>
          <dd>
            {!shipping.count
              ? '—'
              : shipping.cents > 0
                ? `≈ ${formatLocalFromEurCents(shipping.cents, currency)}${shipping.missing ? ' + more at checkout' : ''}`
                : 'at checkout'}
          </dd>
        </div>
        {signedIn ? (
          <div>
            <dt>Site balance</dt>
            <dd className={covered ? 'is-ok' : ''}>{formatPkn(availablePkn) || '0 PKN'}</dd>
          </div>
        ) : null}
      </dl>
      {signedIn && subtotal > 0 ? (
        <p className="bk-sum-hint">
          {covered
            ? 'Your PKN balance covers these cards. Card payment works too.'
            : 'Pay by card at checkout, or top up PKN in your wallet.'}
        </p>
      ) : null}
      <label className="bk-gift">
        <input type="checkbox" checked={gift} onChange={(event) => onGift(event.target.checked)} />
        This order contains a gift
      </label>
      {n > 0 ? (
        <Link className="btn bk-checkout" to={signedIn ? '/checkout' : authFrom('/checkout')}>
          {signedIn ? 'Proceed to checkout' : 'Sign in to check out'}
        </Link>
      ) : (
        <span className="btn bk-checkout is-disabled" aria-disabled="true">Proceed to checkout</span>
      )}
      {!delivery.saved ? (
        <p className="bk-sum-fine">Shipping is estimated for {deliveryName}; checkout quotes your address.</p>
      ) : null}
    </div>
  );
}

/** Prime's slot: Pokoin Flex, one bag for many sellers. */
export function FlexCard({ parcels }) {
  return (
    <div className="bk-flex">
      <div className="bk-flex-top">
        <strong className="pokoin-flex-mark" aria-label="Pokoin Flex">
          <img className="pokoin-flex-logo" src={brandSrc('pokoin-logo-flat.svg')} alt="" width="96" height="31" />
          <span className="flex-tag" aria-hidden="true">Flex</span>
        </strong>
        <p>
          {parcels > 1
            ? `Your cart ships as ${parcels} parcels. Flex puts many sellers' cards in one bag.`
            : 'Many sellers, one bag: Flex ships cards together for less.'}
        </p>
      </div>
      <Link className="bk-btn-o bk-flex-btn" to="/flex">How Flex works</Link>
    </div>
  );
}
