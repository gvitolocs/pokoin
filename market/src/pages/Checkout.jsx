import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import {
  createMarketplaceOrder,
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
import { fiatFromPkn, currencyForCountry, currencyFromLocale, formatLocalFromPkn, formatLocalFromEurCents } from '../pkn.js';
import { pknFromEurCents, previewShipmentCents } from '../shipping-quote.js';
import CardArt from '../components/CardArt.jsx';
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

const EMPTY_ADDRESS = {
  fullName: '',
  addressLine1: '',
  addressLine2: '',
  postalCode: '',
  city: '',
  countryCode: 'DK',
  phoneNumber: '',
};

function selectedAddressCountry(addresses, addressId) {
  const row = (addresses || []).find((item) => item.id === addressId);
  return String(row?.countryCode || '').trim().toUpperCase();
}

export default function Checkout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { ready, signedIn, user, getBearer, availablePkn } = useAuth();
  const { items, count, subtotalPkn, canNftOnly, clear } = useCart();
  const [nftOnly, setNftOnly] = useState(false);
  const [insurance, setInsurance] = useState(false);
  const [notes, setNotes] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [orderId, setOrderId] = useState('');
  const [payMethod, setPayMethod] = useState('stripe'); // stripe | pkn
  const [addresses, setAddresses] = useState([]);
  const [addressId, setAddressId] = useState('');
  const [draft, setDraft] = useState(EMPTY_ADDRESS);
  const [showAddressForm, setShowAddressForm] = useState(false);
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState('');

  const nft = nftOnly && canNftOnly;
  const buyerCountry = String(
    selectedAddressCountry(addresses, addressId) || draft.countryCode || 'DK',
  ).toUpperCase();
  const shippingPreviewCents = useMemo(() => {
    if (nft || !items.length) return 0;
    let total = 0;
    let missing = false;
    const bySeller = new Map();
    for (const row of items) {
      const sid = String(row.sellerUid || '');
      const list = bySeller.get(sid) || { count: 0, from: row.sellerCountry || '' };
      list.count += Number(row.qty) || 0;
      list.from = list.from || row.sellerCountry || '';
      bySeller.set(sid, list);
    }
    for (const group of bySeller.values()) {
      const cents = previewShipmentCents({
        fromCountry: group.from,
        toCountry: buyerCountry,
        cardCount: group.count,
      });
      if (cents == null) {
        missing = true;
        break;
      }
      total += cents;
    }
    return missing ? null : total;
  }, [nft, items, buyerCountry]);

  const shippingPkn = nft
    ? 0
    : (shippingPreviewCents != null
      ? pknFromEurCents(shippingPreviewCents)
      : (items.length ? CHECKOUT_SHIPPING_PKN : 0));
  const fees = checkoutFees(subtotalPkn, { insurance: insurance && !nft, shippingPkn });
  const { commissionPkn, insurancePkn, taxPkn, totalPkn, coveragePkn } = fees;
  const missingListing = items.some((row) => !row.listingId);
  const canPayWithPkn = Number(availablePkn) >= Number(totalPkn);
  const preferFiat = !nft && !canPayWithPkn;
  const displayCurrency = currencyForCountry(buyerCountry) || currencyFromLocale();
  const eurSubtotal = useMemo(
    () => Math.round((Number(fiatFromPkn(subtotalPkn, 'EUR')) || 0) * 100),
    [subtotalPkn],
  );

  function moneyFromPkn(pkn) {
    return preferFiat || payMethod === 'stripe'
      ? formatLocalFromPkn(pkn, displayCurrency)
      : formatPkn(pkn);
  }

  function moneyFromEurCents(cents) {
    return formatLocalFromEurCents(cents, displayCurrency);
  }

  useEffect(() => {
    if (preferFiat && payMethod === 'pkn') setPayMethod('stripe');
  }, [preferFiat, payMethod]);

  useEffect(() => {
    document.title = 'Checkout · Pokoin';
  }, []);

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

  useEffect(() => {
    if (nft || payMethod !== 'stripe' || !addressId || !items.length || missingListing) {
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
          shippingAddressId: addressId,
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
  }, [nft, payMethod, addressId, items, missingListing, getBearer]);

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
      setDraft(EMPTY_ADDRESS);
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
      }, token);
      if (!data.checkoutUrl) {
        throw new Error('Stripe did not return a checkout URL.');
      }
      clear();
      window.location.assign(data.checkoutUrl);
    } catch (err) {
      setError(err.message || 'Could not open Stripe.');
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
            ? `Prices shown in ${displayCurrency} (converted from PKN). Stripe charges the EUR equivalent; shipping is quoted from your address.`
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
      {preferFiat ? (
        <Alert>
          Site PKN ({formatPknNumber(availablePkn)}) is not enough — amounts are PKN converted to {displayCurrency}. Pay with card (Stripe charges EUR).
        </Alert>
      ) : null}
      <Alert>{error}</Alert>
      {orderId ? (
        <p className="desk-ok">
          Paid order {orderId}.{' '}
          <Link to="/orders">View orders</Link>
          {nft ? <> · <Link to="/collection">Collection</Link></> : null}
        </p>
      ) : null}
      {!items.length && !orderId ? (
        <EmptyDesk title="Nothing to pay" lede="Add a native listing from Shop, then return here.">
          <Link className="btn" to="/marketplace">Marketplace</Link>
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
                    {row.image ? <CardArt src={row.image} alt="" full /> : <span className="suggest-ph" />}
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
              <p className="page-lede">
                Physical delivery. Shipping is quoted per seller once you choose an address.
              </p>
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
                    <em>Shown in {displayCurrency} · charged in EUR</em>
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
                    <em>{preferFiat ? `Need ${formatPknNumber(totalPkn)} PKN · you have ${formatPknNumber(availablePkn)}` : 'Pay from your Pokoin balance'}</em>
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
                    ['countryCode', 'Country code (ISO)'],
                    ['phoneNumber', 'Phone (optional)'],
                  ].map(([key, label]) => (
                    <label className="sell-field" key={key}>
                      {label}
                      <input
                        value={draft[key]}
                        onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
                        required={key !== 'addressLine2' && key !== 'phoneNumber'}
                        maxLength={key === 'countryCode' ? 2 : 180}
                      />
                    </label>
                  ))}
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
            actions={confirm ? (
              <>
                <button
                  className="btn"
                  type="button"
                  disabled={busy || (payMethod === 'stripe' && !quote)}
                  onClick={() => (payMethod === 'stripe' && !nft ? placeStripe() : placePkn())}
                >
                  {busy
                    ? (payMethod === 'stripe' && !nft ? 'Opening Stripe…' : 'Paying…')
                    : (payMethod === 'stripe' && !nft ? 'Pay with Stripe' : 'Confirm order')}
                </button>
                <button className="btn ghost" type="button" onClick={() => setConfirm(false)}>Review again</button>
              </>
            ) : (
              <>
                <button
                  className="btn"
                  type="button"
                  disabled={busy || missingListing || (payMethod === 'stripe' && !nft && (!addressId || !quote))}
                  onClick={() => setConfirm(true)}
                >
                  Place order
                </button>
                <button className="btn ghost" type="button" onClick={() => navigate('/cart')}>Back to cart</button>
              </>
            )}
          >
            {payMethod === 'stripe' && !nft && quote ? (
              <dl className="fee-lines">
                {(quote.shipments || []).map((shipment) => (
                  <div key={shipment.sellerId}>
                    <dt>
                      Shipping {shipment.fromCountry} → {shipment.toCountry}
                      {' '}({shipment.cardCount || shipment.itemCount} cards · {shipment.serviceName || 'Standard'})
                    </dt>
                    <dd>{moneyFromEurCents(shipment.amountCents)}</dd>
                  </div>
                ))}
                <div>
                  <dt>Items</dt>
                  <dd>{moneyFromEurCents(quote.itemsSubtotalCents || eurSubtotal)}</dd>
                </div>
                <div>
                  <dt>Shipping total</dt>
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
                  <dt>Shipping{shippingPreviewCents != null ? ` (${buyerCountry})` : ''}</dt>
                  <dd>
                    {shippingPreviewCents != null
                      ? moneyFromEurCents(shippingPreviewCents)
                      : 'Quoted after you save a shipping address'}
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
            {confirm ? (
              <p className="page-lede">
                {nft
                  ? `Pay ${formatPkn(totalPkn)} from your site balance. The cards go into your collection. Nothing is mailed.`
                  : payMethod === 'stripe'
                    ? `Pay ${moneyFromEurCents(quote?.grandTotalCents)} with card. Stripe charges the EUR equivalent; shipping quote is frozen on the server.`
                    : `Pay ${formatPkn(totalPkn)} from your site balance. ${ESCROW_LINE}`}
              </p>
            ) : null}
            {missingListing ? <Alert>A cart row is missing listingId. Add the offer from Shop again.</Alert> : null}
          </DeskPanel>
        </div>
      ) : null}
    </div>
  );
}
