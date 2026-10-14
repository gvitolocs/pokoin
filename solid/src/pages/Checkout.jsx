import { createEffect, createMemo, createSignal, For, Match, onSettled, Show, Switch, untrack } from 'solid-js';
import { useLocation, useNavigate, useSearchParams } from '@solidjs/router';
import {
  cancelEurOrder,
  createMarketplaceOrder,
  createOrderCheckoutSession,
  fetchAccountAddresses,
  fetchPknRefusingSellers,
  formatPkn,
  formatPknNumber,
  quoteMarketplaceCheckout,
  saveAccountAddress,
} from '@market/api.js';
import { brandSrc } from '@market/brand-assets.js';
import { ESCROW_LINE, NO_SHIP_GUARANTEE } from '@market/buyer-protection.js';
import { looseCardReference, writeListingDrag } from '@market/chat-listing.js';
import { checkoutFees, pknBalanceVoucher } from '@market/checkout-fees.js';
import {
  ADDRESS_FIELDS,
  CHECKOUT_SHIPPING_PKN,
  GIFT_NOTE,
  MISSING_LISTING_ERROR,
  addressFieldRequired,
  checkoutCartPayload,
  checkoutSellerKey,
  checkoutSellerParcels,
  checkoutShipOptions,
  checkoutShippingPreviewCents,
  emptyAddressDraft,
  orderLineSnapshot,
  pknEligibleSubtotal,
  selectedAddressCountry,
  stripeSessionError,
} from '@market/checkout-model.js';
import { estimatedDeliveryDate, optInFields, showReviewsOptIn } from '@market/google-reviews.js';
import {
  currencyForCountry,
  currencyFromLocale,
  fiatFromPkn,
  formatFiatFromPkn,
  formatLocalFromEurCents,
  formatLocalFromPkn,
} from '@market/pkn.js';
import { SHIP_TO_COUNTRIES, shipFromCountryName, shipFromCountryOptionLabel } from '@market/ship-countries.js';
import {
  cheapestServiceId,
  eurCentsFromPkn,
  pknFromEurCents,
  untrackedAllowed,
} from '@market/shipping-quote.js';
import { cartTotals } from '@market/cart-model.js';
import ArtworkZoom from '../components/ArtworkZoom.jsx';
import { Alert, DeskPanel, EmptyDesk, Metric, MetricGrid, PageHead } from '../components/Desk.jsx';
import RequireSignIn from '../components/RequireSignIn.jsx';
import { availablePkn } from '../stores/account.js';
import { authUser, getBearer } from '../stores/auth.js';
import { cartGift, cartItems } from '../stores/cart.js';
import {
  cartCanNftOnly,
  cartCheckoutItems,
  cartInsurance,
  cartShippingChoice,
  cartUseBalance,
  markCheckoutPending,
  removeCartItems,
  setCartGift,
  setCartInsurance,
  setCartShippingChoice,
  setCartUseBalance,
} from '../stores/cart-actions.js';

function FeeTip(props) {
  return (
    <span class="fee-tip">
      <button type="button" class="fee-tip-btn" aria-label={props.label}>i</button>
      <span class="fee-tip-pop" role="tooltip">{props.children}</span>
    </span>
  );
}

function InsuranceCheck(props) {
  return (
    <label class="fee-check">
      <input type="checkbox" checked={cartInsurance()} onChange={(event) => setCartInsurance(event.target.checked)} />
      Insurance 5%
      {props.children}
    </label>
  );
}

function CheckoutDesk() {
  const navigate = useNavigate();
  const location = useLocation();
  const [, setSearchParams] = useSearchParams();
  // Only the ticked cart rows check out; unticked ones stay in the cart.
  const items = cartCheckoutItems;
  const totals = createMemo(() => cartTotals(cartItems()));
  const count = () => totals().selectedCount;
  const subtotalPkn = () => totals().selectedSubtotalPkn;
  const [nftOnly, setNftOnly] = createSignal(false);
  const [notes, setNotes] = createSignal(untrack(() => (cartGift() ? GIFT_NOTE : '')));
  const [confirm, setConfirm] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [orderId, setOrderId] = createSignal('');
  const [payMethod, setPayMethod] = createSignal('stripe'); // stripe | pkn
  const [addresses, setAddresses] = createSignal([]);
  const [addressId, setAddressId] = createSignal('');
  const [draft, setDraft] = createSignal(untrack(() => emptyAddressDraft(cartShippingChoice().country)));
  const [showAddressForm, setShowAddressForm] = createSignal(false);
  const [quote, setQuote] = createSignal(null);
  const [quoteError, setQuoteError] = createSignal('');
  // The service picked in the cart carries over; checkout still lists every option.
  const [shippingService, setShippingService] = createSignal(untrack(() => cartShippingChoice().service || 'tracked'));
  const [shippingPicked, setShippingPicked] = createSignal(untrack(() => Boolean(cartShippingChoice().service)));
  const [pknRefused, setPknRefused] = createSignal([]); // sellers who take card payments only

  const nft = () => nftOnly() && cartCanNftOnly();
  const buyerCountry = () => String(selectedAddressCountry(addresses(), addressId()) || draft().countryCode || 'DK').toUpperCase();
  const shippingTracked = () => shippingService() !== 'untracked';
  const sellerParcels = createMemo(() => checkoutSellerParcels(items(), quote()?.sellerOrigins || {}));
  const allowUntracked = () => untrackedAllowed(eurCentsFromPkn(subtotalPkn()));
  const shipOptions = createMemo(() => checkoutShipOptions({
    nft: nft(),
    sellerParcels: sellerParcels(),
    buyerCountry: buyerCountry(),
    allowUntracked: allowUntracked(),
  }));
  const shippingPreviewCents = createMemo(() => checkoutShippingPreviewCents({
    nft: nft(),
    itemCount: items().length,
    quote: quote(),
    sellerParcels: sellerParcels(),
    buyerCountry: buyerCountry(),
    tracked: shippingTracked(),
  }));
  const shippingPkn = () => (nft()
    ? 0
    : (shippingPreviewCents() != null
      ? pknFromEurCents(shippingPreviewCents())
      : (items().length ? CHECKOUT_SHIPPING_PKN : 0)));
  const fees = createMemo(() => checkoutFees(subtotalPkn(), { insurance: cartInsurance() && !nft(), shippingPkn: shippingPkn() }));
  const missingListing = () => items().some((row) => !row.listingId);
  const canPayWithPkn = () => Number(availablePkn()) >= Number(fees().totalPkn);
  const pknBlocked = () => pknRefused().length > 0;
  const pknRefusedNames = () => pknRefused().map((row) => row.name).join(', ');
  const preferFiat = () => !nft() && (!canPayWithPkn() || pknBlocked());
  const displayCurrency = () => currencyForCountry(buyerCountry()) || currencyFromLocale();
  // PKN balance as a discount: only lines from sellers who accept PKN count,
  // the card charge keeps a 50-cent floor (the session create re-applies it).
  const voucher = createMemo(() => pknBalanceVoucher({
    availablePkn: availablePkn(),
    eligiblePkn: pknEligibleSubtotal(items(), pknRefused()),
    chargeEurCents: Math.round(Number(fiatFromPkn(fees().totalPkn, 'EUR')) * 100),
  }));
  const pknDiscountEurCents = () => (cartUseBalance() ? voucher().eurCents : 0);
  const pknDiscountPkn = () => pknDiscountEurCents() * 2;
  const eurSubtotal = () => Math.round((Number(fiatFromPkn(subtotalPkn(), 'EUR')) || 0) * 100);
  const canPayStripe = () => !nft()
    && payMethod() === 'stripe'
    && Boolean(addressId())
    && Boolean(quote()?.grandTotalCents)
    && !missingListing()
    && !quote()?.preview;
  const insured = () => cartInsurance() && !allowUntracked();

  function moneyFromPkn(pkn) {
    if (preferFiat()) return formatFiatFromPkn(pkn, displayCurrency());
    if (payMethod() === 'stripe') return formatLocalFromPkn(pkn, displayCurrency());
    return formatPkn(pkn);
  }

  function moneyFromEurCents(cents) {
    return formatLocalFromEurCents(cents, displayCurrency());
  }

  // Cheapest bookable service unless the buyer picked one. Untracked is not bookable above €20.
  createEffect(
    () => [shipOptions(), shippingService(), shippingPicked()],
    ([options, current, picked]) => {
      if (!options.length) return;
      const selectable = options.filter((row) => !row.unavailable);
      if (!picked || !selectable.some((row) => row.id === current)) {
        const next = cheapestServiceId(selectable, { allowUntracked: untrack(allowUntracked) }) || 'tracked';
        if (next !== current) setShippingService(next);
      }
    },
  );

  createEffect(
    () => preferFiat() && payMethod() === 'pkn',
    (fallBack) => {
      if (fallBack) setPayMethod('stripe');
    },
  );

  // Back from Stripe Cancel: nothing was charged; close that session now so
  // the held cards go straight back on sale instead of waiting out the hold.
  createEffect(
    () => {
      const params = new URLSearchParams(location.search);
      return params.get('cancelled') === '1' ? String(params.get('order') || '').trim() || '-' : '';
    },
    (cancelled) => {
      if (!cancelled) return;
      setNotice('Stripe payment was cancelled. Nothing was charged and your cart is still here.');
      setBusy(false);
      setSearchParams({ cancelled: undefined, order: undefined }, { replace: true });
      if (cancelled === '-') return;
      (async () => {
        try {
          const token = await getBearer();
          await cancelEurOrder(cancelled, token);
        } catch (err) {
          if (err?.body?.code === 'already_paid') navigate('/orders', { replace: true });
          // Otherwise the hold simply expires on its own.
        }
      })();
    },
  );

  createEffect(nft, (digital) => {
    if (digital) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const token = await getBearer();
        const data = await fetchAccountAddresses(token, { reveal: true });
        if (cancelled) return;
        const list = data.addresses || [];
        setAddresses(() => list);
        const preferred = list.find((row) => row.isDefault) || list[0];
        setAddressId(preferred?.id || '');
        setShowAddressForm(!list.length);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load addresses.');
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  createEffect(
    () => checkoutSellerKey(items()),
    (sellerKey) => {
      if (!sellerKey) {
        setPknRefused([]);
        return undefined;
      }
      let cancelled = false;
      getBearer()
        .then((token) => fetchPknRefusingSellers(sellerKey.split(','), token))
        .then((data) => { if (!cancelled) setPknRefused(() => (Array.isArray(data?.pknRefused) ? data.pknRefused : [])); })
        .catch(() => { if (!cancelled) setPknRefused([]); });
      return () => {
        cancelled = true;
      };
    },
  );

  // Server quote for a card payment (debounced); the server re-prices every line.
  createEffect(
    () => {
      if (nft() || payMethod() !== 'stripe' || !items().length || missingListing() || !buyerCountry()) return null;
      return {
        items: checkoutCartPayload(items()),
        ...(addressId() ? { shippingAddressId: addressId() } : { toCountry: buyerCountry() }),
        shippingService: shippingService(),
        tracked: shippingTracked(),
        insurance: cartInsurance() && !nft() && !allowUntracked(),
      };
    },
    (body) => {
      if (!body) {
        setQuote(null);
        setQuoteError('');
        return undefined;
      }
      let cancelled = false;
      const timer = setTimeout(async () => {
        try {
          const token = await getBearer();
          const data = await quoteMarketplaceCheckout(body, token);
          if (cancelled) return;
          setQuote(() => data);
          setQuoteError('');
        } catch (err) {
          if (cancelled) return;
          setQuote(null);
          setQuoteError(err.message || 'Shipping is not available for this route.');
        }
      }, 200);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    },
  );

  async function saveAddress(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      const data = await saveAccountAddress({ ...draft(), isDefault: !addresses().length }, token);
      const saved = data.address;
      setAddresses((current) => [saved, ...current.filter((row) => row.id !== saved.id)]);
      setAddressId(saved.id);
      setShowAddressForm(false);
      setDraft(emptyAddressDraft());
    } catch (err) {
      setError(err.message || 'Could not save address.');
    } finally {
      setBusy(false);
    }
  }

  async function placePkn() {
    if (missingListing()) {
      setError(MISSING_LISTING_ERROR);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      const rows = items();
      const { taxPkn, totalPkn } = fees();
      const data = await createMarketplaceOrder({
        buyerEmail: authUser()?.email || '',
        items: rows.map((row) => orderLineSnapshot(row, nft() ? 'nft_only' : 'physical', notes().trim())),
        subtotalPkn: subtotalPkn(),
        taxPkn,
        shippingPkn: shippingPkn(),
        totalPkn,
        fulfillmentMode: nft() ? 'nft_only' : 'physical',
      }, token);
      const id = data?.order?.id || data?.id || '';
      setOrderId(id);
      // Google Customer Reviews opt-in for a physical order (never NFT-only).
      if (!nft()) {
        showReviewsOptIn(optInFields({
          orderId: id,
          email: authUser()?.email,
          deliveryCountry: buyerCountry(),
          estimatedDelivery: estimatedDeliveryDate({
            orderedAt: Date.now(),
            shipments: sellerParcels().map((group) => ({ fromCountry: group.from })),
            toCountry: buyerCountry(),
          }),
        }));
      }
      removeCartItems(rows.map((row) => row.id));
      setCartGift(false);
      setConfirm(false);
    } catch (err) {
      setError(err.message || 'Checkout failed.');
      if (err?.body?.code === 'seller_no_pkn') {
        setConfirm(false);
        setPayMethod('stripe');
      }
    } finally {
      setBusy(false);
    }
  }

  async function placeStripe() {
    if (missingListing()) {
      setError(MISSING_LISTING_ERROR);
      return;
    }
    if (!addressId()) {
      setError('Add a shipping address before paying with Stripe.');
      return;
    }
    if (!quote()?.grandTotalCents) {
      setError(quoteError() || 'Shipping quote is required before Stripe.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      const rows = items();
      // Server recalculates — never send client shipping cents.
      const data = await createOrderCheckoutSession({
        buyerEmail: authUser()?.email || '',
        items: checkoutCartPayload(rows),
        shippingAddressId: addressId(),
        shippingService: shippingService(),
        tracked: shippingTracked(),
        insurance: insured() && !nft(),
        usePknDiscount: pknDiscountPkn() >= 1,
      }, token);
      if (!data.checkoutUrl) {
        throw new Error('Stripe did not return a checkout URL.');
      }
      // Keep the cart until Stripe success (/orders?eur_session=…) so cancel can
      // return here. Orders then drops exactly these rows; unticked ones stay.
      markCheckoutPending(rows.map((row) => row.id));
      window.location.assign(data.checkoutUrl);
    } catch (err) {
      setError(stripeSessionError(err));
      setBusy(false);
    }
  }

  const selectedAddress = () => addresses().find((row) => row.id === addressId());
  const dueLabel = () => {
    if (payMethod() !== 'stripe') return formatPkn(fees().totalPkn);
    if (quote()) return moneyFromEurCents(quote().grandTotalCents);
    if (shippingPreviewCents() != null) return moneyFromEurCents(eurSubtotal() + shippingPreviewCents());
    return `${moneyFromPkn(subtotalPkn())} + ship`;
  };

  return (
    <div class="page desk">
      <PageHead
        kicker="Shop"
        title="Checkout"
        lede={nft()
          ? 'You pay with your site balance and the cards go into your collection. Nothing is mailed.'
          : payMethod() === 'stripe'
            ? `Prices in ${displayCurrency()}. Shipping is quoted from your address.`
            : `${ESCROW_LINE} ${NO_SHIP_GUARANTEE}`}
      >
        <a class="btn ghost" href="/cart">Cart</a>
        <Show when={!nft()}><a class="btn ghost" href="/protection">Buyer protection</a></Show>
      </PageHead>
      <MetricGrid>
        <Metric value={count()} label="Items" />
        <Metric value={formatPknNumber(availablePkn())} label="Site PKN" />
        <Metric value={dueLabel()} label="Due" />
      </MetricGrid>
      <Alert>{error()}</Alert>
      <Show when={notice()}><p class="desk-ok">{notice()}</p></Show>
      <Show when={orderId()}>
        <p class="desk-ok">
          Paid order {orderId()}.{' '}
          <a href="/orders">View orders</a>
          <Show when={nft()}> · <a href="/mypokoin/collection">Collection</a></Show>
        </p>
      </Show>
      <Show when={!items().length && !orderId()}>
        <Show
          when={cartItems().length}
          fallback={(
            <EmptyDesk title="Cart is empty" lede="Add a listing from Shop, then come back to pay with card or site PKN.">
              <a class="btn" href="/marketplace">Browse marketplace</a>
              <a class="btn ghost" href="/cart">Open cart</a>
            </EmptyDesk>
          )}
        >
          <EmptyDesk
            icon="cart"
            title="No cards selected"
            lede="Tick the cards you want to buy in your cart. Unticked cards stay there for later."
          >
            <a class="btn" href="/cart">Open cart</a>
          </EmptyDesk>
        </Show>
      </Show>
      <Show when={items().length}>
        <div class="wallet-desk">
          <DeskPanel title="Order">
            <div class="bag-list">
              <For each={items()}>
                {(row) => (
                  <article class="bag-row summary">
                    <a
                      href={row.href || '/marketplace'}
                      class="bag-art"
                      draggable="true"
                      onDragStart={(event) => writeListingDrag(event, looseCardReference({
                        imageUrl: row.image,
                        name: row.name,
                        href: row.href,
                        cardId: row.cardId,
                        sellerUid: row.sellerUid,
                        pricePkn: row.pricePkn,
                        listingId: row.listingId,
                      }))}
                    >
                      <Show when={row.image} fallback={<span class="suggest-ph" />}>
                        <ArtworkZoom src={row.image} name={row.name} set={row.set || row.card?.set || ''} alt={row.name} />
                      </Show>
                    </a>
                    <div class="bag-info">
                      <strong class="bag-name">{row.name}</strong>
                      <p class="bag-seller">{row.condition} · {row.sellerName} · qty {row.qty}</p>
                    </div>
                    <strong class="bag-price">
                      {moneyFromPkn((Number(row.pricePkn) || 0) * (Number(row.qty) || 1))}
                    </strong>
                  </article>
                )}
              </For>
            </div>
            <Show
              when={cartCanNftOnly()}
              fallback={(
                <>
                  <p class="page-lede">
                    Physical delivery to {shipFromCountryName(buyerCountry()) || buyerCountry()}
                    {sellerParcels()[0]?.from
                      ? ` · from ${sellerParcels().map((g) => shipFromCountryName(g.from) || g.from).filter(Boolean).join(', ')}`
                      : ''}
                    {shippingPreviewCents() != null ? ` · ${moneyFromEurCents(shippingPreviewCents())}` : ''}
                  </p>
                  <Switch fallback={<p class="page-lede">Looking up shipping…</p>}>
                    <Match when={shipOptions().length}>
                      <div class="checkout-pay" role="radiogroup" aria-label="Shipping service">
                        <span class="checkout-pay-label">Shipping</span>
                        <For each={shipOptions()}>
                          {(option) => {
                            const unavailable = Boolean(option.unavailable);
                            return (
                              <label
                                class={[
                                  'checkout-pay-option',
                                  {
                                    'is-on': shippingService() === option.id,
                                    'is-unavailable': unavailable,
                                    'is-pokoin-flex': option.brand === 'pokoin-flex',
                                  },
                                ]}
                              >
                                <input
                                  type="radio"
                                  name="shippingService"
                                  checked={!unavailable && shippingService() === option.id}
                                  disabled={unavailable}
                                  onChange={() => {
                                    if (unavailable) return;
                                    setShippingPicked(true);
                                    setShippingService(option.id);
                                    setCartShippingChoice({ service: option.id });
                                  }}
                                />
                                <span>
                                  <Show when={option.brand === 'pokoin-flex'} fallback={<strong>{option.label}</strong>}>
                                    <strong class="pokoin-flex-mark is-inline" aria-label="Pokoin Flex">
                                      <img class="pokoin-flex-logo" src={brandSrc('pokoin-logo-flat.svg')} alt="" width="96" height="31" />
                                      <span class="flex-tag" aria-hidden="true">Flex</span>
                                    </strong>
                                  </Show>
                                  <em>
                                    {unavailable
                                      ? (option.unavailableReason || 'Unavailable')
                                      : [
                                        moneyFromEurCents(option.amountCents),
                                        option.serviceName,
                                        option.fromCountry && option.toCountry ? `${option.fromCountry} → ${option.toCountry}` : '',
                                      ].filter(Boolean).join(' · ')}
                                    <Show when={unavailable}>
                                      {' · '}
                                      <a href={option.href || '/flex'}>How Flex works</a>
                                    </Show>
                                  </em>
                                  <Show when={!unavailable && option.parcels?.length > 1}>
                                    <For each={option.parcels}>
                                      {(parcel) => (
                                        <em class="checkout-parcel-line">
                                          {[
                                            `${shipFromCountryName(parcel.fromCountry) || parcel.fromCountry} → ${shipFromCountryName(parcel.toCountry) || parcel.toCountry}`,
                                            parcel.serviceName,
                                            moneyFromEurCents(parcel.amountCents),
                                          ].filter(Boolean).join(' · ')}
                                        </em>
                                      )}
                                    </For>
                                  </Show>
                                </span>
                              </label>
                            );
                          }}
                        </For>
                      </div>
                    </Match>
                    <Match when={quoteError()}>
                      <Alert>{quoteError()}</Alert>
                    </Match>
                  </Switch>
                </>
              )}
            >
              <label class="page-lede">
                <input type="checkbox" checked={nft()} onChange={(event) => setNftOnly(event.target.checked)} />
                {' '}Digital only. The cards go into your collection and nothing is mailed. Shipping is 0.
              </label>
            </Show>
            <Show when={!nft()}>
              <div class="checkout-pay" role="radiogroup" aria-label="Pay with">
                <span class="checkout-pay-label">Pay with</span>
                <label class={['checkout-pay-option', { 'is-on': payMethod() === 'stripe' }]}>
                  <input type="radio" name="payMethod" checked={payMethod() === 'stripe'} onChange={() => setPayMethod('stripe')} />
                  <span>
                    <strong>Card (Stripe)</strong>
                  </span>
                </label>
                <label class={['checkout-pay-option', { 'is-on': payMethod() === 'pkn', 'is-disabled': preferFiat() }]}>
                  <input
                    type="radio"
                    name="payMethod"
                    checked={payMethod() === 'pkn'}
                    disabled={preferFiat()}
                    onChange={() => setPayMethod('pkn')}
                  />
                  <span>
                    <strong>Site PKN</strong>
                    <em>
                      {pknBlocked()
                        ? `${pknRefusedNames()} ${pknRefused().length === 1 ? 'accepts' : 'accept'} card payments only`
                        : preferFiat() ? 'Not enough balance' : 'Pay from your Pokoin balance'}
                    </em>
                  </span>
                </label>
              </div>
            </Show>
            <label class="sell-field">
              Notes
              <textarea value={notes()} onInput={(event) => setNotes(event.target.value)} rows={2} />
            </label>
          </DeskPanel>

          <Show when={!nft() && payMethod() === 'stripe'}>
            <DeskPanel title="Shipping address">
              <Show when={selectedAddress() && !showAddressForm()}>
                <div class="page-lede">
                  <p>
                    <strong>{selectedAddress().fullName}</strong><br />
                    {selectedAddress().addressLine1}<br />
                    {selectedAddress().postalCode} {selectedAddress().city}<br />
                    {selectedAddress().countryCode}
                  </p>
                  <button class="btn ghost" type="button" onClick={() => setShowAddressForm(true)}>
                    Change
                  </button>
                  <Show when={addresses().length > 1}>
                    <label class="sell-field">
                      Saved addresses
                      <select value={addressId()} onChange={(event) => setAddressId(event.target.value)}>
                        <For each={addresses()}>
                          {(row) => (
                            <option value={row.id}>
                              {row.fullName || row.label || row.id} ({row.countryCode})
                            </option>
                          )}
                        </For>
                      </select>
                    </label>
                  </Show>
                </div>
              </Show>
              <Show when={showAddressForm() || !addresses().length}>
                <form class="sell-form" onSubmit={saveAddress}>
                  <p class="page-lede">Add shipping address</p>
                  <For each={ADDRESS_FIELDS}>
                    {([key, label]) => (
                      <label class="sell-field">
                        {label}
                        <input
                          value={draft()[key]}
                          onInput={(event) => {
                            const value = event.target.value;
                            setDraft((current) => ({ ...current, [key]: value }));
                          }}
                          required={addressFieldRequired(key)}
                          maxLength={180}
                        />
                      </label>
                    )}
                  </For>
                  <label class="sell-field">
                    Country
                    <select
                      value={draft().countryCode}
                      onChange={(event) => {
                        const value = event.target.value.toUpperCase();
                        setDraft((current) => ({ ...current, countryCode: value }));
                      }}
                      required
                    >
                      <For each={SHIP_TO_COUNTRIES}>
                        {(row) => <option value={row.code}>{shipFromCountryOptionLabel(row.code)}</option>}
                      </For>
                    </select>
                  </label>
                  <button class="btn" type="submit" disabled={busy()}>
                    {busy() ? 'Saving…' : 'Save address'}
                  </button>
                </form>
              </Show>
              <Show when={quoteError()}><Alert>{quoteError()}</Alert></Show>
            </DeskPanel>
          </Show>

          <DeskPanel
            title="Pay"
            actions={(
              <Switch>
                <Match when={payMethod() === 'stripe' && !nft()}>
                  <button class="btn stripe" type="button" disabled={busy() || !canPayStripe()} onClick={() => placeStripe()}>
                    {busy() ? 'Opening Stripe…' : 'Pay with Stripe'}
                  </button>
                  <button class="btn ghost" type="button" onClick={() => navigate('/cart')}>
                    Back to cart
                  </button>
                </Match>
                <Match when={confirm()}>
                  <button class="btn" type="button" disabled={busy()} onClick={() => placePkn()}>
                    {busy() ? 'Paying…' : 'Confirm order'}
                  </button>
                  <button class="btn ghost" type="button" onClick={() => setConfirm(false)}>
                    Review again
                  </button>
                </Match>
                <Match when={true}>
                  <button class="btn" type="button" disabled={busy() || missingListing()} onClick={() => setConfirm(true)}>
                    Place order
                  </button>
                  <button class="btn ghost" type="button" onClick={() => navigate('/cart')}>
                    Back to cart
                  </button>
                </Match>
              </Switch>
            )}
          >
            <Switch
              fallback={(
                <dl class="fee-lines">
                  <div>
                    <dt>Subtotal</dt>
                    <dd>{formatPkn(subtotalPkn())}</dd>
                  </div>
                  <div>
                    <dt>
                      <span>Platform commission 3%</span>
                      <FeeTip label="About the platform commission">
                        Pokoin keeps 3% of the card prices on every order.
                      </FeeTip>
                    </dt>
                    <dd>{formatPkn(fees().commissionPkn)}</dd>
                  </div>
                  <Show when={!nft()}>
                    <div>
                      <dt>
                        <InsuranceCheck />
                        <FeeTip label="About insurance">
                          If the package is lost, this covers 80% of the order value
                          {fees().coveragePkn > 0 ? ` (${formatPkn(fees().coveragePkn)})` : ''}. Leave it off if you don&apos;t want it.
                        </FeeTip>
                      </dt>
                      <dd>{formatPkn(fees().insurancePkn)}</dd>
                    </div>
                  </Show>
                  <div>
                    <dt>Shipping</dt>
                    <dd>{formatPkn(shippingPkn())}</dd>
                  </div>
                  <div>
                    <dt>Total</dt>
                    <dd>{formatPkn(fees().totalPkn)}</dd>
                  </div>
                </dl>
              )}
            >
              <Match when={payMethod() === 'stripe' && !nft() && quote()}>
                {(q) => (
                  <dl class="fee-lines">
                    <div>
                      <dt>Items</dt>
                      <dd>{moneyFromEurCents(q().itemsSubtotalCents || eurSubtotal())}</dd>
                    </div>
                    <Show
                      when={(q().shipments || []).length > 1}
                      fallback={(
                        <div>
                          <dt>
                            Shipping
                            {q().shipments?.[0] ? ` · ${q().shipments[0].fromCountry} → ${q().shipments[0].toCountry}` : ''}
                          </dt>
                          <dd>{moneyFromEurCents(q().shippingTotalCents)}</dd>
                        </div>
                      )}
                    >
                      {/* One parcel per seller: each ships and is charged on its own lane. */}
                      <For each={q().shipments}>
                        {(shipment) => (
                          <div>
                            <dt>Shipping · {shipment.fromCountry} → {shipment.toCountry}</dt>
                            <dd>{moneyFromEurCents(shipment.amountCents)}</dd>
                          </div>
                        )}
                      </For>
                    </Show>
                    <Show when={!allowUntracked()}>
                      <div>
                        <dt><InsuranceCheck /></dt>
                        <dd>{moneyFromEurCents(q().insuranceCents || 0)}</dd>
                      </div>
                    </Show>
                    <div>
                      <dt>Total</dt>
                      <dd>{moneyFromEurCents(q().grandTotalCents)}</dd>
                    </div>
                  </dl>
                )}
              </Match>
              <Match when={payMethod() === 'stripe' && !nft()}>
                <dl class="fee-lines">
                  <div>
                    <dt>Items</dt>
                    <dd>{moneyFromPkn(subtotalPkn())}</dd>
                  </div>
                  <div>
                    <dt>Shipping{shippingPreviewCents() != null ? ` · ${shipFromCountryName(buyerCountry()) || buyerCountry()}` : ''}</dt>
                    <dd>
                      {shippingPreviewCents() != null
                        ? moneyFromEurCents(shippingPreviewCents())
                        : (quoteError() || 'Looking up shipping…')}
                    </dd>
                  </div>
                  <Show when={!allowUntracked()}>
                    <div>
                      <dt><InsuranceCheck /></dt>
                      <dd>{moneyFromEurCents(cartInsurance() ? Math.round(eurSubtotal() * 0.05) : 0)}</dd>
                    </div>
                  </Show>
                  <div>
                    <dt>Estimated total</dt>
                    <dd>
                      {shippingPreviewCents() != null
                        ? moneyFromEurCents(eurSubtotal() + shippingPreviewCents() + (insured() ? Math.round(eurSubtotal() * 0.05) : 0))
                        : moneyFromPkn(subtotalPkn())}
                    </dd>
                  </div>
                  <Show when={voucher().pkn >= 1}>
                    <div>
                      <dt>
                        <label class="checkout-pkn-voucher">
                          <input
                            type="checkbox"
                            checked={cartUseBalance()}
                            onChange={(event) => setCartUseBalance(event.target.checked)}
                          />
                          {' '}Use my PKN balance as a discount
                        </label>
                      </dt>
                      <dd>{voucher().pkn} PKN = {moneyFromEurCents(voucher().eurCents)}</dd>
                    </div>
                  </Show>
                  <Show when={pknDiscountPkn() >= 1}>
                    <div>
                      <dt>PKN balance discount</dt>
                      <dd>−{pknDiscountPkn()} PKN ({moneyFromEurCents(pknDiscountEurCents())})</dd>
                    </div>
                    <div>
                      <dt>Card charge</dt>
                      <dd>
                        {shippingPreviewCents() != null
                          ? moneyFromEurCents(Math.max(50, eurSubtotal() + shippingPreviewCents() - pknDiscountEurCents()))
                          : moneyFromPkn(Math.max(1, subtotalPkn() - pknDiscountPkn()))}
                      </dd>
                    </div>
                  </Show>
                </dl>
              </Match>
            </Switch>
            <Show when={confirm() && payMethod() === 'pkn'}>
              <p class="page-lede">
                {nft()
                  ? `Pay ${formatPkn(fees().totalPkn)} from your site balance. The cards go into your collection. Nothing is mailed.`
                  : `Pay ${formatPkn(fees().totalPkn)} from your site balance. ${ESCROW_LINE}`}
              </p>
            </Show>
            <Show when={!canPayStripe() && payMethod() === 'stripe' && !nft() && !addressId()}>
              <p class="page-lede">Save a shipping address to pay with Stripe.</p>
            </Show>
            <Show when={missingListing()}><Alert>{MISSING_LISTING_ERROR}</Alert></Show>
            <Show when={nft() && pknBlocked()}>
              <Alert>{pknRefusedNames()} {pknRefused().length === 1 ? 'accepts' : 'accept'} card payments only, and NFT checkout is paid in PKN. Remove their cards or check out the physical cards by card.</Alert>
            </Show>
          </DeskPanel>
        </div>
      </Show>
    </div>
  );
}

/** /checkout (market/src/pages/Checkout.jsx): the ticked cart rows, paid by Stripe or site PKN. */
export default function Checkout() {
  onSettled(() => {
    document.title = 'Checkout · Pokoin';
  });
  return (
    <RequireSignIn>
      <CheckoutDesk />
    </RequireSignIn>
  );
}
