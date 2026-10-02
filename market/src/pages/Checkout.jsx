import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  cancelEurOrder,
  createMarketplaceOrder,
  fetchPknRefusingSellers,
  createOrderCheckoutSession,
  fetchAccountAddresses,
  formatPkn,
  formatPknNumber,
  quoteMarketplaceCheckout,
  saveAccountAddress,
} from '../api.js';
import { ESCROW_LINE, NO_SHIP_GUARANTEE } from '../buyer-protection.js';
import { useAuth } from '../auth.jsx';
import { CHECKOUT_SHIPPING_PKN, useCart } from '../cart.jsx';
import { checkoutFees } from '../checkout-fees.js';
import { looseCardReference, writeListingDrag } from '../chat-listing.js';
import { authFrom } from '../punchouts.js';
import { fiatFromPkn, currencyForCountry, currencyFromLocale, countryFromLocale, formatLocalFromPkn, formatLocalFromEurCents } from '../pkn.js';
import { SHIP_FROM_COUNTRIES, shipFromCountryName, shipFromCountryOptionLabel } from '../ship-countries.js';
import { brandSrc } from '../brand-assets.js';
import {
  defaultShippingService,
  pknFromEurCents,
  previewShipmentCents,
  shippingServiceOptions,
} from '../shipping-quote.js';
import ArtworkZoom from '../components/ArtworkZoom.jsx';
import { Alert, DeskPanel, EmptyDesk, Metric, MetricGrid, PageHead, SessionWait } from '../components/Desk.jsx';

function FeeTip({ label, children }) {
  return (
    <span className="fee-tip">
      <button type="button" className="fee-tip-btn" aria-label={label}>i</button>
      <span className="fee-tip-pop" role="tooltip">{children}</span>
    </span>
  );
}

function snapshot(row, fulfillmentMode, notes) {
  const qty = Number(row.qty) || 1;
  const unit = Number(row.pricePkn) || 0;
  return {
    listingId: row.listingId,
    sellerUid: row.sellerUid,
    sellerName: row.sellerName,
    quantity: qty,
    unitPricePkn: unit,
    totalPricePkn: unit * qty,
    condition: row.condition,
    language: row.language,
    reserveAvailable: Boolean(row.reserveAvailable),
    nftAvailable: Boolean(row.nftAvailable),
    fulfillmentMode,
    card: row.card || { id: row.cardId, name: row.name },
    ...(notes ? { buyerNotes: notes } : {}),
  };
}

function cartPayload(items) {
  return items.map((row) => ({
    listingId: row.listingId,
    sellerUid: row.sellerUid,
    sellerName: row.sellerName,
    qty: Number(row.qty) || 1,
    quantity: Number(row.qty) || 1,
    pricePkn: Number(row.pricePkn) || 0,
    unitPricePkn: Number(row.pricePkn) || 0,
    cardId: row.cardId,
    name: row.name,
    card: row.card || { id: row.cardId, name: row.name },
  }));
}

function emptyAddressDraft() {
  const localeCountry = countryFromLocale();
  const known = SHIP_FROM_COUNTRIES.some((row) => row.code === localeCountry);
  return {
    fullName: '',
    addressLine1: '',
    addressLine2: '',
    postalCode: '',
    city: '',
    countryCode: known ? localeCountry : 'DK',
    phoneNumber: '',
  };
}

function selectedAddressCountry(addresses, addressId) {
  const row = (addresses || []).find((item) => item.id === addressId);
  return String(row?.countryCode || '').trim().toUpperCase();
}

export default function Checkout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { ready, signedIn, user, getBearer, availablePkn } = useAuth();
  const { items, count, subtotalPkn, canNftOnly, clear } = useCart();
  const [nftOnly, setNftOnly] = useState(false);
  const [insurance, setInsurance] = useState(false);
  const [notes, setNotes] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [orderId, setOrderId] = useState('');
  const [payMethod, setPayMethod] = useState('stripe'); // stripe | pkn
  const [addresses, setAddresses] = useState([]);
  const [addressId, setAddressId] = useState('');
  const [draft, setDraft] = useState(emptyAddressDraft);
  const [showAddressForm, setShowAddressForm] = useState(false);
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const [shippingService, setShippingService] = useState('tracked'); // tracked | untracked
  const [shippingPicked, setShippingPicked] = useState(false); // buyer chose a service
  const [pknRefused, setPknRefused] = useState([]); // sellers who take card payments only
  const [usePknDiscount, setUsePknDiscount] = useState(false); // opt-in PKN balance voucher
  const stripeCancelled = searchParams.get('cancelled') === '1';
  const cancelledOrderId = String(searchParams.get('order') || '').trim();

  const nft = nftOnly && canNftOnly;
  const buyerCountry = String(
    selectedAddressCountry(addresses, addressId) || draft.countryCode || 'DK',
  ).toUpperCase();
  const shippingTracked = shippingService !== 'untracked';

  const sellerParcels = useMemo(() => {
    const origins = quote?.sellerOrigins || {};
    const bySeller = new Map();
    for (const row of items) {
      const sid = String(row.sellerUid || '');
      const fromProfile = String(origins[sid] || '').toUpperCase();
      const list = bySeller.get(sid) || {
        sellerId: sid,
        sellerName: row.sellerName || '',
        count: 0,
        from: fromProfile || String(row.sellerCountry || '').toUpperCase(),
      };
      list.count += Number(row.qty) || 0;
      list.from = list.from || fromProfile || String(row.sellerCountry || '').toUpperCase();
      list.sellerName = list.sellerName || row.sellerName || '';
      bySeller.set(sid, list);
    }
    return [...bySeller.values()];
  }, [items, quote?.sellerOrigins]);

  const shipOptions = useMemo(() => {
    if (nft || !sellerParcels.length) return [];
    for (const group of sellerParcels) {
      if (!group.from) continue;
      const options = shippingServiceOptions({
        fromCountry: group.from,
        toCountry: buyerCountry,
        cardCount: group.count,
      });
      if (options.length) return options;
    }
    return [];
  }, [nft, sellerParcels, buyerCountry]);

  const shippingPreviewCents = useMemo(() => {
    if (nft || !items.length) return 0;
    if (quote && Number.isFinite(Number(quote.shippingTotalCents))) {
      return Number(quote.shippingTotalCents);
    }
    let total = 0;
    let missing = false;
    for (const group of sellerParcels) {
      if (!group.from) {
        missing = true;
        break;
      }
      const cents = previewShipmentCents({
        fromCountry: group.from,
        toCountry: buyerCountry,
        cardCount: group.count,
        tracked: shippingTracked,
      });
      if (cents == null) {
        missing = true;
        break;
      }
      total += cents;
    }
    return missing ? null : total;
  }, [nft, items.length, sellerParcels, buyerCountry, shippingTracked, quote]);

  const shippingPkn = nft
    ? 0
    : (shippingPreviewCents != null
      ? pknFromEurCents(shippingPreviewCents)
      : (items.length ? CHECKOUT_SHIPPING_PKN : 0));
  const fees = checkoutFees(subtotalPkn, { insurance: insurance && !nft, shippingPkn });
  const { commissionPkn, insurancePkn, taxPkn, totalPkn, coveragePkn } = fees;
  const missingListing = items.some((row) => !row.listingId);
  const canPayWithPkn = Number(availablePkn) >= Number(totalPkn);
  const pknBlocked = pknRefused.length > 0;
  const pknRefusedNames = pknRefused.map((row) => row.name).join(', ');
  const preferFiat = !nft && (!canPayWithPkn || pknBlocked);
  const displayCurrency = currencyForCountry(buyerCountry) || currencyFromLocale();
  // PKN balance as a discount: only lines from sellers who accept PKN count,
  // the card charge keeps a 50-cent floor. The session create applies the
  // authoritative number server-side; this is the same math for the preview.
  const pknEligiblePkn = items.reduce((sum, row) => (
    pknRefused.some((row2) => row2.uid === row.sellerUid)
      ? sum
      : sum + Math.max(0, Number(row.pricePkn) || 0) * Math.max(0, Number(row.qty) || 0)
  ), 0);
  // 1 PKN = €0.005 → 2 PKN per euro-cent, rounded down (server: _checkout_core).
  // Opt-in: nothing is discounted until the buyer ticks the voucher box.
  const pknVoucherEurCents = Math.max(0, Math.min(
    Math.floor(Math.min(Number(availablePkn) || 0, Math.trunc(pknEligiblePkn)) / 2),
    Math.round(Number(fiatFromPkn(totalPkn, 'EUR')) * 100) - 50,
  ));
  const pknVoucherPkn = pknVoucherEurCents * 2;
  const pknDiscountEurCents = usePknDiscount ? pknVoucherEurCents : 0;
  const pknDiscountPkn = pknDiscountEurCents * 2;
  const eurSubtotal = useMemo(
    () => Math.round((Number(fiatFromPkn(subtotalPkn, 'EUR')) || 0) * 100),
    [subtotalPkn],
  );
  const canPayStripe = !nft
    && payMethod === 'stripe'
    && Boolean(addressId)
    && Boolean(quote?.grandTotalCents)
    && !missingListing
    && !quote?.preview;

  function moneyFromPkn(pkn) {
    return preferFiat || payMethod === 'stripe'
      ? formatLocalFromPkn(pkn, displayCurrency)
      : formatPkn(pkn);
  }

  function moneyFromEurCents(cents) {
    return formatLocalFromEurCents(cents, displayCurrency);
  }

  useEffect(() => {
    if (!shipOptions.length) return;
    const selectable = shipOptions.filter((row) => !row.unavailable);
    // Until the buyer picks, a few cards default to the untracked letter.
    if (!shippingPicked || !selectable.some((row) => row.id === shippingService)) {
      const next = defaultShippingService(shipOptions);
      if (next !== shippingService) setShippingService(next);
    }
  }, [shipOptions, shippingService, shippingPicked]);

  useEffect(() => {
    if (preferFiat && payMethod === 'pkn') setPayMethod('stripe');
  }, [preferFiat, payMethod]);

  useEffect(() => {
    document.title = 'Checkout · Pokoin';
  }, []);

  useEffect(() => {
    if (!stripeCancelled) return;
    setNotice('Stripe payment was cancelled. Nothing was charged and your cart is still here.');
    setBusy(false);
    setSearchParams((prev) => {
      if (!prev.has('cancelled') && !prev.has('order')) return prev;
      const next = new URLSearchParams(prev);
      next.delete('cancelled');
      next.delete('order');
      return next;
    }, { replace: true });
  }, [stripeCancelled, setSearchParams]);

  // Stripe Cancel → close that session now so the held cards go straight back
  // on sale instead of waiting out the 30-minute hold.
  useEffect(() => {
    if (!stripeCancelled || !cancelledOrderId || !signedIn) return;
    (async () => {
      try {
        const token = await getBearer();
        await cancelEurOrder(cancelledOrderId, token);
      } catch (err) {
        if (err?.body?.code === 'already_paid') {
          navigate('/orders', { replace: true });
        }
        // Otherwise the hold simply expires on its own.
      }
    })();
  }, [stripeCancelled, cancelledOrderId, signedIn, getBearer, navigate]);

  useEffect(() => {
    if (!signedIn || nft) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const token = await getBearer();
        const data = await fetchAccountAddresses(token, { reveal: true });
        if (cancelled) return;
        const list = data.addresses || [];
        setAddresses(list);
        const preferred = list.find((row) => row.isDefault) || list[0];
        setAddressId(preferred?.id || '');
        setShowAddressForm(!list.length);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load addresses.');
      }
    })();
    return () => { cancelled = true; };
  }, [signedIn, nft, getBearer]);

  const sellerKey = [...new Set(items.map((row) => String(row.sellerUid || '')).filter(Boolean))].sort().join(',');
  useEffect(() => {
    if (!signedIn || !sellerKey) {
      setPknRefused([]);
      return undefined;
    }
    let cancelled = false;
    getBearer()
      .then((token) => fetchPknRefusingSellers(sellerKey.split(','), token))
      .then((data) => { if (!cancelled) setPknRefused(Array.isArray(data?.pknRefused) ? data.pknRefused : []); })
      .catch(() => { if (!cancelled) setPknRefused([]); });
    return () => { cancelled = true; };
  }, [signedIn, sellerKey, getBearer]);

  useEffect(() => {
    if (nft || payMethod !== 'stripe' || !items.length || missingListing || !buyerCountry) {
      setQuote(null);
      setQuoteError('');
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const token = await getBearer();
        const data = await quoteMarketplaceCheckout({
          items: cartPayload(items),
          ...(addressId ? { shippingAddressId: addressId } : { toCountry: buyerCountry }),
          shippingService,
          tracked: shippingTracked,
        }, token);
        if (cancelled) return;
        setQuote(data);
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
  }, [nft, payMethod, addressId, buyerCountry, items, missingListing, getBearer, shippingService, shippingTracked]);

  if (!ready) {
    return <SessionWait />;
  }
  if (!signedIn) {
    return <Navigate to={authFrom(location.pathname || '/checkout')} replace />;
  }

  async function saveAddress(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      const data = await saveAccountAddress({ ...draft, isDefault: !addresses.length }, token);
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
    if (missingListing) {
      setError('A cart row is missing listingId. Add the offer from Shop again.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      const data = await createMarketplaceOrder({
        buyerEmail: user?.email || '',
        items: items.map((row) => snapshot(row, nft ? 'nft_only' : 'physical', notes.trim())),
        subtotalPkn,
        taxPkn,
        shippingPkn,
        totalPkn,
        fulfillmentMode: nft ? 'nft_only' : 'physical',
      }, token);
      const id = data?.order?.id || data?.id || '';
      setOrderId(id);
      clear();
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
    if (missingListing) {
      setError('A cart row is missing listingId. Add the offer from Shop again.');
      return;
    }
    if (!addressId) {
      setError('Add a shipping address before paying with Stripe.');
      return;
    }
    if (!quote?.grandTotalCents) {
      setError(quoteError || 'Shipping quote is required before Stripe.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const token = await getBearer();
      // Server recalculates — never send client shipping cents.
      const data = await createOrderCheckoutSession({
        buyerEmail: user?.email || '',
        items: cartPayload(items),
        shippingAddressId: addressId,
        shippingService,
        tracked: shippingTracked,
        usePknDiscount: pknDiscountPkn >= 1,
      }, token);
      if (!data.checkoutUrl) {
        throw new Error('Stripe did not return a checkout URL.');
      }
      // Keep the cart until Stripe success (/orders?eur_session=…) so cancel can return here.
      window.location.assign(data.checkoutUrl);
    } catch (err) {
      const code = err?.body?.code;
      setError(code === 'price_mismatch' || err?.status === 409
        ? `${err.message} Refresh the card in your cart and try again — nothing was charged.`
        : (err.message || 'Could not open Stripe.'));
      setBusy(false);
    }
  }

  const selectedAddress = addresses.find((row) => row.id === addressId);

  return (
    <div className="page desk">
      <PageHead
        kicker="Shop"
        title="Checkout"
        lede={nft
          ? 'You pay with your site balance and the cards go into your collection. Nothing is mailed.'
          : payMethod === 'stripe'
            ? `Prices in ${displayCurrency}. Shipping is quoted from your address.`
            : `${ESCROW_LINE} ${NO_SHIP_GUARANTEE}`}
      >
        <Link className="btn ghost" to="/cart">Cart</Link>
        {nft ? null : <Link className="btn ghost" to="/protection">Buyer protection</Link>}
      </PageHead>
      <MetricGrid>
        <Metric value={count} label="Items" />
        <Metric value={formatPknNumber(availablePkn)} label="Site PKN" />
        <Metric
          value={
            payMethod === 'stripe'
              ? (quote
                ? moneyFromEurCents(quote.grandTotalCents)
                : (shippingPreviewCents != null
                  ? moneyFromEurCents(eurSubtotal + shippingPreviewCents)
                  : `${moneyFromPkn(subtotalPkn)} + ship`))
              : formatPkn(totalPkn)
          }
          label="Due"
        />
      </MetricGrid>
      <Alert>{error}</Alert>
      {notice ? <p className="desk-ok">{notice}</p> : null}
      {orderId ? (
        <p className="desk-ok">
          Paid order {orderId}.{' '}
          <Link to="/orders">View orders</Link>
          {nft ? <> · <Link to="/collection">Collection</Link></> : null}
        </p>
      ) : null}
      {!items.length && !orderId ? (
        <EmptyDesk
          title="Cart is empty"
          lede="Add a listing from Shop, then come back to pay with card or site PKN."
        >
          <Link className="btn" to="/marketplace">Browse marketplace</Link>
          <Link className="btn ghost" to="/cart">Open cart</Link>
        </EmptyDesk>
      ) : null}
      {items.length ? (
        <div className="wallet-desk">
          <DeskPanel title="Order">
            <div className="bag-list">
              {items.map((row) => (
                <article className="bag-row summary" key={row.id}>
                  <Link
                    to={row.href || '/marketplace'}
                    className="bag-art"
                    draggable
                    onDragStart={(event) => writeListingDrag(event, looseCardReference({
                      imageUrl: row.image, name: row.name, href: row.href, cardId: row.cardId,
                      sellerUid: row.sellerUid, pricePkn: row.pricePkn, listingId: row.listingId,
                    }))}
                  >
                    {row.image ? (
                      <ArtworkZoom src={row.image} name={row.name} set={row.set || row.card?.set || ''} alt={row.name} />
                    ) : <span className="suggest-ph" />}
                  </Link>
                  <div className="bag-info">
                    <strong className="bag-name">{row.name}</strong>
                    <p className="bag-seller">{row.condition} · {row.sellerName} · qty {row.qty}</p>
                  </div>
                  <strong className="bag-price">
                    {moneyFromPkn((Number(row.pricePkn) || 0) * (Number(row.qty) || 1))}
                  </strong>
                </article>
              ))}
            </div>
            {canNftOnly ? (
              <label className="page-lede">
                <input type="checkbox" checked={nft} onChange={(event) => setNftOnly(event.target.checked)} />
                {' '}Digital only. The cards go into your collection and nothing is mailed. Shipping is 0.
              </label>
            ) : (
              <>
                <p className="page-lede">
                  Physical delivery to {shipFromCountryName(buyerCountry) || buyerCountry}
                  {sellerParcels[0]?.from
                    ? ` · from ${sellerParcels.map((g) => shipFromCountryName(g.from) || g.from).filter(Boolean).join(', ')}`
                    : ''}
                  {shippingPreviewCents != null
                    ? ` · ${moneyFromEurCents(shippingPreviewCents)}`
                    : ''}
                </p>
                {shipOptions.length ? (
                  <div className="checkout-pay" role="radiogroup" aria-label="Shipping service">
                    <span className="checkout-pay-label">Shipping</span>
                    {shipOptions.map((option) => {
                      const unavailable = Boolean(option.unavailable);
                      return (
                        <label
                          key={option.id}
                          className={`checkout-pay-option${shippingService === option.id ? ' is-on' : ''}${unavailable ? ' is-unavailable' : ''}${option.brand === 'pokoin-flex' ? ' is-pokoin-flex' : ''}`}
                        >
                          <input
                            type="radio"
                            name="shippingService"
                            checked={!unavailable && shippingService === option.id}
                            disabled={unavailable}
                            onChange={() => {
                              if (!unavailable) {
                                setShippingPicked(true);
                                setShippingService(option.id);
                              }
                            }}
                          />
                          <span>
                            {option.brand === 'pokoin-flex' ? (
                              <strong className="pokoin-flex-mark is-inline" aria-label="Pokoin Flex">
                                <img
                                  className="pokoin-flex-logo"
                                  src={brandSrc('pokoin-logo-flat.svg')}
                                  alt=""
                                  width="96"
                                  height="31"
                                />
                                <span className="flex-tag" aria-hidden="true">Flex</span>
                              </strong>
                            ) : (
                              <strong>{option.label}</strong>
                            )}
                            <em>
                              {unavailable
                                ? (option.unavailableReason || 'Unavailable')
                                : [
                                  moneyFromEurCents(option.amountCents),
                                  option.serviceName,
                                  option.fromCountry && option.toCountry
                                    ? `${option.fromCountry} → ${option.toCountry}`
                                    : '',
                                ].filter(Boolean).join(' · ')}
                              {unavailable ? (
                                <>
                                  {' · '}
                                  <Link to={option.href || '/flex'}>How Flex works</Link>
                                </>
                              ) : null}
                            </em>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : quoteError ? (
                  <Alert>{quoteError}</Alert>
                ) : (
                  <p className="page-lede">Looking up shipping…</p>
                )}
              </>
            )}
            {!nft ? (
              <div className="checkout-pay" role="radiogroup" aria-label="Pay with">
                <span className="checkout-pay-label">Pay with</span>
                <label className={`checkout-pay-option${payMethod === 'stripe' ? ' is-on' : ''}`}>
                  <input
                    type="radio"
                    name="payMethod"
                    checked={payMethod === 'stripe'}
                    onChange={() => setPayMethod('stripe')}
                  />
                  <span>
                    <strong>Card (Stripe)</strong>
                  </span>
                </label>
                <label className={`checkout-pay-option${payMethod === 'pkn' ? ' is-on' : ''}${preferFiat ? ' is-disabled' : ''}`}>
                  <input
                    type="radio"
                    name="payMethod"
                    checked={payMethod === 'pkn'}
                    disabled={preferFiat}
                    onChange={() => setPayMethod('pkn')}
                  />
                  <span>
                    <strong>Site PKN</strong>
                    <em>
                      {pknBlocked
                        ? `${pknRefusedNames} ${pknRefused.length === 1 ? 'accepts' : 'accept'} card payments only`
                        : preferFiat ? 'Not enough balance' : 'Pay from your Pokoin balance'}
                    </em>
                  </span>
                </label>
              </div>
            ) : null}
            <label className="sell-field">
              Notes
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
            </label>
          </DeskPanel>

          {!nft && payMethod === 'stripe' ? (
            <DeskPanel title="Shipping address">
              {selectedAddress && !showAddressForm ? (
                <div className="page-lede">
                  <p>
                    <strong>{selectedAddress.fullName}</strong><br />
                    {selectedAddress.addressLine1}<br />
                    {selectedAddress.postalCode} {selectedAddress.city}<br />
                    {selectedAddress.countryCode}
                  </p>
                  <button className="btn ghost" type="button" onClick={() => setShowAddressForm(true)}>
                    Change
                  </button>
                  {addresses.length > 1 ? (
                    <label className="sell-field">
                      Saved addresses
                      <select value={addressId} onChange={(event) => setAddressId(event.target.value)}>
                        {addresses.map((row) => (
                          <option key={row.id} value={row.id}>
                            {row.fullName || row.label || row.id} ({row.countryCode})
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
              ) : null}
              {showAddressForm || !addresses.length ? (
                <form className="sell-form" onSubmit={saveAddress}>
                  <p className="page-lede">Add shipping address</p>
                  {[
                    ['fullName', 'Full name'],
                    ['addressLine1', 'Address line 1'],
                    ['addressLine2', 'Address line 2 (optional)'],
                    ['postalCode', 'Postal code'],
                    ['city', 'City'],
                    ['phoneNumber', 'Phone (optional)'],
                  ].map(([key, label]) => (
                    <label className="sell-field" key={key}>
                      {label}
                      <input
                        value={draft[key]}
                        onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
                        required={key !== 'addressLine2' && key !== 'phoneNumber'}
                        maxLength={180}
                      />
                    </label>
                  ))}
                  <label className="sell-field">
                    Country
                    <select
                      value={draft.countryCode}
                      onChange={(event) => setDraft((current) => ({
                        ...current,
                        countryCode: event.target.value.toUpperCase(),
                      }))}
                      required
                    >
                      {SHIP_FROM_COUNTRIES.map((row) => (
                        <option key={row.code} value={row.code}>
                          {shipFromCountryOptionLabel(row.code)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="btn" type="submit" disabled={busy}>
                    {busy ? 'Saving…' : 'Save address'}
                  </button>
                </form>
              ) : null}
              {quoteError ? <Alert>{quoteError}</Alert> : null}
            </DeskPanel>
          ) : null}

          <DeskPanel
            title="Pay"
            actions={
              payMethod === 'stripe' && !nft ? (
                <>
                  <button
                    className="btn stripe"
                    type="button"
                    disabled={busy || !canPayStripe}
                    onClick={() => placeStripe()}
                  >
                    {busy ? 'Opening Stripe…' : 'Pay with Stripe'}
                  </button>
                  <button className="btn ghost" type="button" onClick={() => navigate('/cart')}>
                    Back to cart
                  </button>
                </>
              ) : confirm ? (
                <>
                  <button
                    className="btn"
                    type="button"
                    disabled={busy}
                    onClick={() => placePkn()}
                  >
                    {busy ? 'Paying…' : 'Confirm order'}
                  </button>
                  <button className="btn ghost" type="button" onClick={() => setConfirm(false)}>
                    Review again
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="btn"
                    type="button"
                    disabled={busy || missingListing}
                    onClick={() => setConfirm(true)}
                  >
                    Place order
                  </button>
                  <button className="btn ghost" type="button" onClick={() => navigate('/cart')}>
                    Back to cart
                  </button>
                </>
              )
            }
          >
            {payMethod === 'stripe' && !nft && quote ? (
              <dl className="fee-lines">
                <div>
                  <dt>Items</dt>
                  <dd>{moneyFromEurCents(quote.itemsSubtotalCents || eurSubtotal)}</dd>
                </div>
                <div>
                  <dt>
                    Shipping
                    {quote.shipments?.[0]
                      ? ` · ${quote.shipments[0].fromCountry} → ${quote.shipments[0].toCountry}`
                      : ''}
                  </dt>
                  <dd>{moneyFromEurCents(quote.shippingTotalCents)}</dd>
                </div>
                <div>
                  <dt>Total</dt>
                  <dd>{moneyFromEurCents(quote.grandTotalCents)}</dd>
                </div>
              </dl>
            ) : payMethod === 'stripe' && !nft ? (
              <dl className="fee-lines">
                <div>
                  <dt>Items</dt>
                  <dd>{moneyFromPkn(subtotalPkn)}</dd>
                </div>
                <div>
                  <dt>Shipping{shippingPreviewCents != null ? ` · ${shipFromCountryName(buyerCountry) || buyerCountry}` : ''}</dt>
                  <dd>
                    {shippingPreviewCents != null
                      ? moneyFromEurCents(shippingPreviewCents)
                      : (quoteError || 'Looking up shipping…')}
                  </dd>
                </div>
                <div>
                  <dt>Estimated total</dt>
                  <dd>
                    {shippingPreviewCents != null
                      ? moneyFromEurCents(eurSubtotal + shippingPreviewCents)
                      : moneyFromPkn(subtotalPkn)}
                  </dd>
                </div>
                {pknVoucherPkn >= 1 ? (
                  <div>
                    <dt>
                      <label className="checkout-pkn-voucher">
                        <input
                          type="checkbox"
                          checked={usePknDiscount}
                          onChange={(event) => setUsePknDiscount(event.target.checked)}
                        />
                        {' '}Use my PKN balance as a discount
                      </label>
                    </dt>
                    <dd>{pknVoucherPkn} PKN = {moneyFromEurCents(pknVoucherEurCents)}</dd>
                  </div>
                ) : null}
                {pknDiscountPkn >= 1 ? (
                  <>
                    <div>
                      <dt>PKN balance discount</dt>
                      <dd>−{pknDiscountPkn} PKN ({moneyFromEurCents(pknDiscountEurCents)})</dd>
                    </div>
                    <div>
                      <dt>Card charge</dt>
                      <dd>
                        {shippingPreviewCents != null
                          ? moneyFromEurCents(Math.max(50, eurSubtotal + shippingPreviewCents - pknDiscountEurCents))
                          : moneyFromPkn(Math.max(1, subtotalPkn - pknDiscountPkn))}
                      </dd>
                    </div>
                  </>
                ) : null}
              </dl>
            ) : (
              <dl className="fee-lines">
                <div>
                  <dt>Subtotal</dt>
                  <dd>{formatPkn(subtotalPkn)}</dd>
                </div>
                <div>
                  <dt>
                    <span>Platform commission 3%</span>
                    <FeeTip label="About the platform commission">
                      Pokoin keeps 3% of the card prices on every order.
                    </FeeTip>
                  </dt>
                  <dd>{formatPkn(commissionPkn)}</dd>
                </div>
                {nft ? null : (
                  <div>
                    <dt>
                      <label className="fee-check">
                        <input
                          type="checkbox"
                          checked={insurance}
                          onChange={(event) => setInsurance(event.target.checked)}
                        />
                        Insurance 5%
                      </label>
                      <FeeTip label="About insurance">
                        If the package is lost, this covers 80% of the order value
                        {coveragePkn > 0 ? ` (${formatPkn(coveragePkn)})` : ''}. Leave it off if you don&apos;t want it.
                      </FeeTip>
                    </dt>
                    <dd>{formatPkn(insurancePkn)}</dd>
                  </div>
                )}
                <div>
                  <dt>Shipping</dt>
                  <dd>{formatPkn(shippingPkn)}</dd>
                </div>
                <div>
                  <dt>Total</dt>
                  <dd>{formatPkn(totalPkn)}</dd>
                </div>
              </dl>
            )}
            {confirm && payMethod === 'pkn' ? (
              <p className="page-lede">
                {nft
                  ? `Pay ${formatPkn(totalPkn)} from your site balance. The cards go into your collection. Nothing is mailed.`
                  : `Pay ${formatPkn(totalPkn)} from your site balance. ${ESCROW_LINE}`}
              </p>
            ) : null}
            {!canPayStripe && payMethod === 'stripe' && !nft && !addressId ? (
              <p className="page-lede">Save a shipping address to pay with Stripe.</p>
            ) : null}
            {missingListing ? <Alert>A cart row is missing listingId. Add the offer from Shop again.</Alert> : null}
            {nft && pknBlocked ? (
              <Alert>{pknRefusedNames} {pknRefused.length === 1 ? 'accepts' : 'accept'} card payments only, and NFT checkout is paid in PKN. Remove their cards or check out the physical cards by card.</Alert>
            ) : null}
          </DeskPanel>
        </div>
      ) : null}
    </div>
  );
}
