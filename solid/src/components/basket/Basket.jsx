// Amazon-layout cart pieces: big price,
// basket row, seller parcel bar, "Important messages", the Subtotal box and
// the Flex card. Same markup and classes; market/src/cart.css styles them.

import { createSignal, For, Match, Show, Switch } from 'solid-js';
import {
  LOW_STOCK,
  basketMessageText,
  basketSellerOf,
  cheaperSavePercent,
  fiatParts,
  shareCartRow,
} from '@market/basket-format.js';
import { brandSrc } from '@market/brand-assets.js';
import { game, publicGamePath } from '@market/game.js';
import { isSelected, priceDrop } from '@market/cart-model.js';
import { listingStock } from '@market/cart-qty.js';
import { looseCardReference, writeListingDrag } from '@market/chat-listing.js';
import { printingIdentity } from '@market/identity.js';
import { homepageDerivativeUrl } from '@market/image-urls.js';
import {
  conditionChipSrc,
  conditionShort,
  conditionTone,
  listingExtraTags,
  listingLanguageFlag,
  sellerCountryFlag,
  sellerCountryLabel,
  sellerHref,
} from '@market/listing-meta.js';
import { formatLocalFromEurCents, formatPkn, formatPknNumber } from '@market/pkn.js';
import { authFrom } from '@market/punchouts.js';
import { SHIP_TO_COUNTRIES, shipFromCountryName, shipFromCountryOptionLabel } from '@market/ship-countries.js';
import { buyerCurrency, buyerFiat, buyerFormat, buyerParts, buyerPending } from '../../stores/buyer.js';
import AuthLink from '../AuthLink.jsx';
import CardArt from '../CardArt.jsx';
import { gameHref } from '@market/game.js';

/**
 * Amazon's price: small symbol, big whole part, small raised cents. PKN stays
 * digits only (2642 PKN, never 2,642); an unaffordable price is the local
 * amount alone. (No `?currency=` pin on the cart, so PKN never sits under it.)
 */
export function BigPrice(props) {
  const size = () => props.size || 'lg';
  const pkn = () => Number(props.pricePkn) || 0;
  const accepts = () => props.sellerAcceptsPkn ?? true;
  const local = () => ((props.fiat ?? buyerFiat(pkn(), accepts())) ? fiatParts(pkn(), buyerCurrency()) : null);
  const pknParts = () => formatPknNumber(pkn()).split('.');
  return (
    <Switch
      fallback={(
        <span class={`bk-price is-${size()}`}>
          <span class="bk-price-main">
            <span class="bk-price-int">{pknParts()[0]}</span>
            <Show when={pknParts()[1]}><span class="bk-price-dec">{pknParts()[1]}</span></Show>
            <span class="bk-price-sym is-post">PKN</span>
          </span>
        </span>
      )}
    >
      <Match when={buyerPending()}><span class={`bk-price is-${size()} is-pending`} aria-hidden="true" /></Match>
      <Match when={!(pkn() > 0)}><span class="bk-price is-none">—</span></Match>
      <Match when={local()}>
        {(parts) => (
          <span class={`bk-price is-${size()}`}>
            <span class="bk-price-main">
              <Show when={parts().pre}><span class="bk-price-sym">{parts().pre}</span></Show>
              <span class="bk-price-int">{parts().int}</span>
              <span class="bk-price-dec">{parts().dec}</span>
              <Show when={parts().post}><span class="bk-price-sym is-post">{parts().post}</span></Show>
            </span>
          </span>
        )}
      </Match>
    </Switch>
  );
}

function Flag(props) {
  return (
    <Show when={props.flag}>
      {(flag) => (
        <Show
          when={flag().src}
          fallback={<Show when={flag().emoji}><span class="bk-flag is-emoji" aria-hidden="true">{flag().emoji}</span></Show>}
        >
          <img class="bk-flag" src={flag().src} alt="" title={flag().label} width="16" height="16" />
        </Show>
      )}
    </Show>
  );
}

export function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M4 7h16M9 7V4h6v3m-8.5 0 .8 13h9.4l.8-13M10 11v6m4-6v6" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M5 12h14" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function InfoIcon() {
  return (
    <svg class="bk-info-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="currentColor" />
      <rect x="10.8" y="10" width="2.4" height="7" rx="1.1" fill="#111" />
      <circle cx="12" cy="6.8" r="1.5" fill="#111" />
    </svg>
  );
}

/** Amazon's pill: trash at 1, minus above; plus stops at the seller's stock. */
export function QtyPill(props) {
  const value = () => Math.max(1, Math.trunc(Number(props.qty) || 1));
  const cap = () => Math.max(1, Math.trunc(Number(props.max) || 1));
  const last = () => value() <= 1;
  return (
    <div class="bk-stepper" role="group" aria-label={`Quantity of ${props.name}`}>
      <button
        type="button"
        class="bk-step"
        aria-label={last() ? `Delete ${props.name}` : 'Decrease quantity'}
        title={last() ? 'Delete' : 'Decrease'}
        onClick={() => (last() ? props.onDelete() : props.onChange(value() - 1))}
      >
        <Show when={last()} fallback={<MinusIcon />}><TrashIcon /></Show>
      </button>
      <span class="bk-q" aria-live="polite">{value()}</span>
      <button
        type="button"
        class="bk-step"
        aria-label="Increase quantity"
        title={value() >= cap() ? `Only ${cap()} available` : 'Increase'}
        disabled={value() >= cap()}
        onClick={() => props.onChange(value() + 1)}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

/** One basket line: tick, scan, details + actions, price column. */
export function BasketRow(props) {
  const row = () => props.row;
  const [shared, setShared] = createSignal('');
  const gone = () => Boolean(row().unavailable) || props.live?.status === 'gone';
  const selected = () => isSelected(row()) && !gone();
  const qty = () => Math.max(1, Math.trunc(Number(row().qty) || 1));
  const drop = () => priceDrop(row());
  const href = () => publicGamePath(row().href || '/marketplace', game().id) || row().href || '/marketplace';
  const seller = () => basketSellerOf(row());
  const sellerLink = () => sellerHref(row());
  const countryName = () => sellerCountryLabel(row().sellerCountry);
  const language = () => listingLanguageFlag(row().language);
  const tone = () => conditionTone(row().condition) || 'nm';
  const tags = () => listingExtraTags({ ...row(), reserveAvailable: false, nftAvailable: false });
  const stock = () => (props.live?.status === 'ok' ? props.live.stock : null);
  const cheaper = () => props.live?.cheaper || null;
  const accepts = () => row().sellerAcceptsPkn !== false;
  const setLine = () => printingIdentity({
    id: row().cardId,
    set: row().setName,
    number: row().collectorNumber,
    imageUrl: row().image,
  }).tileLine;

  async function share() {
    const result = await shareCartRow(row());
    setShared(result);
    if (result) window.setTimeout(() => setShared(''), 2200);
  }

  return (
    <article class={['bk-row', { 'is-gone': gone(), 'is-off': !selected() }]} data-row-id={row().id}>
      <label class="bk-check">
        <input
          type="checkbox"
          aria-label={`Buy ${row().name} at checkout`}
          checked={selected()}
          disabled={gone()}
          onChange={(event) => props.onSelect(event.target.checked)}
        />
      </label>
      <a
        class="bk-pic"
        href={gameHref(href())}
        draggable="true"
        onDragStart={(event) => writeListingDrag(event, looseCardReference({
          imageUrl: row().image,
          name: row().name,
          href: row().href,
          cardId: row().cardId,
          sellerUid: row().sellerUid,
          pricePkn: row().pricePkn,
          listingId: row().listingId,
        }))}
      >
        <Show when={row().image} fallback={<span class="bk-pic-ph" />}>
          <CardArt src={homepageDerivativeUrl(row().image) || row().image} alt={row().name} loading="lazy" />
        </Show>
      </a>
      <div class="bk-head">
        <a class="bk-title" href={gameHref(href())}>{row().name}</a>
        <Show when={setLine()}><div class="bk-set">{setLine()}</div></Show>
      </div>
      <div class="bk-body">
        <Switch>
          <Match when={gone()}>
            <div class="bk-stock is-gone">Currently unavailable. This copy sold or the seller took it down.</div>
          </Match>
          <Match when={stock() != null && stock() <= LOW_STOCK}>
            <div class="bk-stock is-low">Only {stock()} left from this seller.</div>
          </Match>
          <Match when={stock() != null}>
            <div class="bk-stock">In stock</div>
          </Match>
          <Match when={props.checking}>
            <div class="bk-stock is-checking">Checking stock…</div>
          </Match>
        </Switch>
        <div class="bk-ship">
          Sold by{' '}
          <Show when={sellerLink()} fallback={<span>{seller()}</span>}>
            <a class="bk-link" href={gameHref(sellerLink())}>{seller()}</a>
          </Show>
          <Show when={countryName()}>
            {' · ships from '}
            <Flag flag={sellerCountryFlag(row().sellerCountry)} />
            {' '}
            {countryName()}
          </Show>
        </div>
        <div class="bk-variant">
          <span>
            <b>Condition: </b>
            <img class={`bk-cond is-${tone()}`} src={conditionChipSrc(row().condition)} alt="" width="30" height="21" />
            {' '}
            {conditionShort(row().condition)}
          </span>
          <Show when={language()}>
            {(lang) => (
              <span>
                <b>Language: </b>
                <Flag flag={lang()} />
                {' '}
                {lang().label}
              </span>
            )}
          </Show>
          <For each={tags()}>
            {(tag) => <em class={tag === 'Reverse' ? 'bk-tag is-reverse' : 'bk-tag'}>{tag}</em>}
          </For>
        </div>
        <Show when={row().nftAvailable || row().reserveAvailable}>
          <div class="bk-digital">
            Digital checkout available: the card can go straight into your collection, nothing is mailed.
          </div>
        </Show>
        <div class="bk-actions">
          <Show
            when={!gone()}
            fallback={<button type="button" class="bk-btn-o is-small" onClick={() => props.onDelete()}>Delete</button>}
          >
            <QtyPill qty={qty()} max={listingStock(row())} name={row().name} onChange={(next) => props.onQty(next)} onDelete={() => props.onDelete()} />
            <span class="bk-div" aria-hidden="true" />
            <button type="button" class="bk-link" onClick={() => props.onDelete()}>Delete</button>
          </Show>
          <span class="bk-div" aria-hidden="true" />
          <button type="button" class="bk-link" onClick={() => props.onSave()}>Save for later</button>
          <span class="bk-div" aria-hidden="true" />
          <button type="button" class="bk-link" onClick={share} aria-live="polite">{shared() || 'Share'}</button>
        </div>
        <Switch>
          <Match when={gone()}>
            <div class="bk-offer is-gone">
              <Show
                when={cheaper()}
                fallback={(
                  <>
                    No other copy in this condition and language right now.{' '}
                    <a class="bk-link" href={gameHref(href())}>See all offers</a>
                  </>
                )}
              >
                {(copy) => (
                  <>
                    Another {conditionShort(copy().condition)} copy is {buyerFormat(copy().pricePkn, copy().sellerAcceptsPkn)} from {basketSellerOf(copy())}.{' '}
                    <button type="button" class="bk-link" onClick={() => props.onSwap(copy())}>Replace it</button>
                  </>
                )}
              </Show>
            </div>
          </Match>
          <Match when={cheaper()}>
            {(copy) => (
              <div class="bk-offer">
                <span class="bk-save-badge">Save {cheaperSavePercent(copy(), row())}%</span>
                {' '}Same card, condition and language for {buyerFormat(copy().pricePkn, copy().sellerAcceptsPkn)} from {basketSellerOf(copy())}.{' '}
                <button type="button" class="bk-link" onClick={() => props.onSwap(copy())}>Swap to it</button>
              </div>
            )}
          </Match>
        </Switch>
      </div>
      <div class="bk-prc">
        <Show when={drop()}><div class="bk-deal-label">Price drop</div></Show>
        <div class="bk-deal-row">
          <Show when={drop()}><span class="bk-deal-badge">-{drop().percent}%</span></Show>
          <BigPrice pricePkn={row().pricePkn} sellerAcceptsPkn={accepts()} />
        </div>
        <Show when={qty() > 1}>
          <div class="bk-unit">{qty()} copies · {buyerFormat(Number(row().pricePkn) * qty(), accepts())}</div>
        </Show>
        <Show when={drop()}>
          <div class="bk-was">Was: <s>{buyerFormat(drop().was, accepts())}</s></div>
        </Show>
        <Show when={!accepts()}>
          <div class="bk-promo"><span class="bk-save-badge is-muted">Card only</span> pay by card</div>
        </Show>
        <Show when={sellerLink()}><a class="bk-link bk-shop" href={gameHref(sellerLink())}>Shop this seller</a></Show>
      </div>
    </article>
  );
}

/** Seller strip above that seller's rows: one parcel, its preview price and room. */
export function SellerBar(props) {
  const group = () => props.group;
  const label = () => basketSellerOf({ sellerUsername: group().sellerUsername, sellerName: group().sellerName });
  const link = () => sellerHref({
    sellerUsername: group().sellerUsername,
    sellerName: group().sellerName,
    sellerUid: group().sellerUid,
  });
  const countryName = () => sellerCountryLabel(group().sellerCountry);
  return (
    <div class="bk-seller-bar">
      <span class="bk-seller-name">
        Parcel from <Show when={link()} fallback={label()}><a class="bk-link" href={gameHref(link())}>{label()}</a></Show>
        <Show when={countryName()}>
          {' · '}
          <Flag flag={sellerCountryFlag(group().sellerCountry)} />
          {' '}
          {countryName()}
        </Show>
      </span>
      <span class="bk-parcel">
        <Switch fallback="Shipping quoted at checkout">
          <Match when={!group().selectedCount}>Nothing ticked from this seller</Match>
          <Match when={props.estimate}>
            {(estimate) => (
              <>
                {estimate().tracked ? 'Tracked' : 'Untracked letter'}
                {estimate().carrier ? ` (${estimate().carrier})` : ''} {formatLocalFromEurCents(estimate().amountCents, props.currency)}
                {estimate().fallback ? ' · your pick is not offered on this route' : ''}
                {estimate().room > 0 ? ` · room for ${estimate().room} more card${estimate().room === 1 ? '' : 's'} at this price` : ''}
              </>
            )}
          </Match>
        </Switch>
      </span>
    </div>
  );
}

/** Amazon's "Important messages about items in your basket". */
export function ImportantMessages(props) {
  const fmt = (pkn) => buyerFormat(pkn);
  return (
    <Show when={props.messages?.length}>
      <div class="bk-messages" role="status">
        <h2>Important messages about items in your cart</h2>
        <ul>
          <For each={props.messages}>
            {(note) => (
              <li class={`is-${note.kind}`}>
                <span>{basketMessageText(note, fmt)}</span>
                <button type="button" class="bk-x" aria-label="Dismiss" onClick={() => props.onDismiss(note.id)}>×</button>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}

/** "€3.13" bold with "626 PKN" under it, or just "626 PKN" when the balance pays. */
export function SubtotalAmount(props) {
  const pkn = () => Number(props.pricePkn) || 0;
  const parts = () => buyerParts(pkn());
  return (
    <Show when={pkn() > 0} fallback={<b class="bk-sub-amt">0 PKN</b>}>
      <span class="bk-sub-amt">
        <b>{parts().local || parts().pkn}</b>
        <Show when={parts().local}><span class="bk-sub-pkn">{parts().pkn}</span></Show>
      </span>
    </Show>
  );
}

/**
 * Right-rail box: parcel nudge, Subtotal, where to deliver and which
 * shipping service, the site-balance discount, gift, checkout.
 */
export function BasketSummary(props) {
  const n = () => props.totals.selectedCount;
  const subtotal = () => props.totals.selectedSubtotalPkn;
  const balance = () => Math.max(0, Math.trunc(Number(props.availablePkn) || 0));
  const discountOn = () => Boolean(props.useBalance && props.discount.pkn >= 1);
  const insuranceCents = () => Math.round((props.subtotalEurCents || 0) * 0.05);
  const nudgeLabel = () => (props.nudge
    ? basketSellerOf({ sellerUsername: props.nudge.group.sellerUsername, sellerName: props.nudge.group.sellerName })
    : '');
  const nudgeLink = () => (props.nudge
    ? sellerHref({
      sellerUsername: props.nudge.group.sellerUsername,
      sellerName: props.nudge.group.sellerName,
      sellerUid: props.nudge.group.sellerUid,
    })
    : '');
  const shippingCell = () => {
    const shipping = props.shipping;
    if (!shipping.count) return '—';
    return shipping.cents > 0
      ? `≈ ${formatLocalFromEurCents(shipping.cents, props.currency)}${shipping.missing ? ' + more at checkout' : ''}`
      : 'not available';
  };
  return (
    <div class="bk-card bk-summary">
      <Show when={props.nudge}>
        {(nudge) => (
          <div class="bk-note">
            <InfoIcon />
            <p>
              Add up to <span class="bk-red">{nudge().estimate.room} more card{nudge().estimate.room === 1 ? '' : 's'}</span> from{' '}
              <Show when={nudgeLink()} fallback={nudgeLabel()}><a class="bk-link" href={gameHref(nudgeLink())}>{nudgeLabel()}</a></Show> to the same parcel: shipping stays{' '}
              <b>{formatLocalFromEurCents(nudge().estimate.amountCents, props.currency)}</b>.{' '}
              <a class="bk-link" href="/shipping">Shipping details</a>
            </p>
          </div>
        )}
      </Show>
      <div class="bk-subtotal">
        Subtotal ({n()} {n() === 1 ? 'item' : 'items'}): <SubtotalAmount pricePkn={subtotal()} />
      </div>

      <div class="bk-ship-fields">
        <label class="bk-field">
          <span>Deliver to</span>
          <select value={props.country} onChange={(event) => props.onCountry(event.target.value)}>
            <For each={SHIP_TO_COUNTRIES}>
              {(row) => <option value={row.code}>{shipFromCountryOptionLabel(row.code)}</option>}
            </For>
          </select>
        </label>
        {/* One parcel per seller, each on its own lane and service. */}
        <For each={props.shipping.parcels}>
          {(parcel) => (
            <div class="bk-field bk-parcel-ship">
              <span>
                Parcel from {basketSellerOf({ sellerUsername: parcel.sellerUsername, sellerName: parcel.sellerName })}
                {' · '}
                <Flag flag={sellerCountryFlag(parcel.from)} />
                {' '}
                {shipFromCountryName(parcel.from) || parcel.from}
              </span>
              <Show
                when={parcel.options.length}
                fallback={(
                  <p class="bk-sum-hint is-warn">
                    No shipping service from {shipFromCountryName(parcel.from) || parcel.from} to {shipFromCountryName(props.country) || props.country} yet.
                  </p>
                )}
              >
                <select
                  aria-label={`Shipping for the parcel from ${basketSellerOf({ sellerUsername: parcel.sellerUsername, sellerName: parcel.sellerName })}`}
                  value={parcel.estimate ? parcel.estimate.serviceId : ''}
                  onChange={(event) => props.onParcelService?.(parcel.key, event.target.value)}
                >
                  <For each={parcel.options}>
                    {(option) => (
                      <option value={option.id}>
                        {option.label}
                        {' · '}
                        {formatLocalFromEurCents(option.amountCents, props.currency)}
                      </option>
                    )}
                  </For>
                </select>
              </Show>
            </div>
          )}
        </For>
        <Show when={props.shipping.count}><a class="bk-link" href="/shipping">Rates for each parcel</a></Show>
      </div>

      <dl class="bk-sum-lines">
        <div>
          <dt>
            Shipping{props.shipping.count ? ` · ${props.shipping.count} parcel${props.shipping.count === 1 ? '' : 's'}` : ''}
          </dt>
          <dd>{shippingCell()}</dd>
        </div>
        <Show when={props.insurance && props.subtotalEurCents > 2000}>
          <div>
            <dt>Insurance 5%</dt>
            <dd>{formatLocalFromEurCents(insuranceCents(), props.currency)}</dd>
          </div>
        </Show>
        <Show when={discountOn()}>
          <div>
            <dt>Site balance discount</dt>
            <dd class="is-ok">−{formatLocalFromEurCents(props.discount.cents, props.currency)} ({props.discount.pkn} PKN)</dd>
          </div>
          <div>
            <dt>Estimated card charge</dt>
            <dd>{formatLocalFromEurCents(props.discount.chargeCents, props.currency)}</dd>
          </div>
        </Show>
      </dl>

      <Show when={props.signedIn}>
        <label class={['bk-balance', { 'is-off': !(props.discount.pkn >= 1) }]}>
          <input
            type="checkbox"
            checked={discountOn()}
            disabled={props.discount.pkn < 1}
            onChange={(event) => props.onUseBalance(event.target.checked)}
          />
          <span>
            Use my site balance as a discount
            <em>
              <Show
                when={balance() > 0}
                fallback={<>No site balance yet · <a class="bk-link" href="/wallet">Top up</a></>}
              >
                {props.discount.pkn >= 1
                  ? `${formatPkn(balance())} available · up to ${props.discount.pkn} PKN on this order`
                  : `${formatPkn(balance())} available · these sellers only take card payments`}
              </Show>
            </em>
          </span>
        </label>
      </Show>

      <Show when={props.subtotalEurCents > 2000 && props.onInsurance}>
        <label class="bk-gift bk-insurance">
          <input
            type="checkbox"
            checked={props.insurance}
            onChange={(event) => props.onInsurance(event.target.checked)}
          />
          <span>
            Insurance 5%
            <em>
              {formatLocalFromEurCents(insuranceCents(), props.currency)}
              {' · covers 80% of the cards if the parcel is lost'}
            </em>
          </span>
        </label>
      </Show>

      <label class="bk-gift">
        <input type="checkbox" checked={props.gift} onChange={(event) => props.onGift(event.target.checked)} />
        This order contains a gift
      </label>
      <Switch fallback={<span class="btn bk-checkout is-disabled" aria-disabled="true">Proceed to checkout</span>}>
        <Match when={n() > 0 && props.signedIn}>
          <a class="btn bk-checkout" href="/checkout">Proceed to checkout</a>
        </Match>
        <Match when={n() > 0}>
          <AuthLink class="btn bk-checkout" to={authFrom('/checkout')}>Sign in to check out</AuthLink>
        </Match>
      </Switch>
      <p class="bk-sum-fine">
        {props.countrySaved
          ? 'Checkout quotes your saved address with the same rates.'
          : 'Checkout quotes the address you enter with the same rates.'}
        {subtotal() > 0 ? ` ${buyerFiat(subtotal()) ? 'Prices shown in your currency; settlement is in PKN.' : ''}` : ''}
      </p>
    </div>
  );
}

/** Prime's slot: Pokoin Flex, one bag for many sellers. */
export function FlexCard(props) {
  return (
    <div class="bk-flex">
      <div class="bk-flex-top">
        <strong class="pokoin-flex-mark" aria-label="Pokoin Flex">
          <img class="pokoin-flex-logo" src={brandSrc('pokoin-logo-flat.svg')} alt="" width="96" height="31" />
          <span class="flex-tag" aria-hidden="true">Flex</span>
        </strong>
        <p>
          {props.parcels > 1
            ? `Your cart ships as ${props.parcels} parcels. Flex puts many sellers' cards in one bag.`
            : 'Many sellers, one bag: Flex ships cards together for less.'}
        </p>
      </div>
      <a class="bk-btn-o bk-flex-btn" href="/flex">How Flex works</a>
    </div>
  );
}
