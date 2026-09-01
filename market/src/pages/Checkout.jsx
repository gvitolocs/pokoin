import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { createMarketplaceOrder, formatPkn } from '../api.js';
import { useAuth } from '../auth.jsx';
import { CHECKOUT_SHIPPING_PKN, CHECKOUT_TAX_RATE, useCart } from '../cart.jsx';
import { authFrom } from '../punchouts.js';
import CardArt from '../components/CardArt.jsx';

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

export default function Checkout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { ready, signedIn, user, getBearer, availablePkn } = useAuth();
  const { items, count, subtotalPkn, canNftOnly, clear } = useCart();
  const [nftOnly, setNftOnly] = useState(false);
  const [notes, setNotes] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [orderId, setOrderId] = useState('');

  const nft = nftOnly && canNftOnly;
  const taxPkn = subtotalPkn * CHECKOUT_TAX_RATE;
  const shippingPkn = nft ? 0 : (items.length ? CHECKOUT_SHIPPING_PKN : 0);
  const totalPkn = subtotalPkn + taxPkn + shippingPkn;
  const missingListing = items.some((row) => !row.listingId);

  useEffect(() => {
    document.title = 'Checkout · Pokoin';
  }, []);

  const totals = useMemo(() => ([
    ['Subtotal', subtotalPkn],
    ['Tax 8%', taxPkn],
    ['Shipping', shippingPkn],
    ['Total', totalPkn],
  ]), [subtotalPkn, taxPkn, shippingPkn, totalPkn]);

  if (!ready) {
    return <div className="page"><p className="muted">Checking session…</p></div>;
  }
  if (!signedIn) {
    return <Navigate to={authFrom(location.pathname || '/checkout')} replace />;
  }

  async function place() {
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

  return (
    <div className="page app-page">
      <div className="comp-head">
        <div>
          <p className="eyebrow">Shop</p>
          <h1>Checkout</h1>
          <p className="muted">Pays site PKN via POST /api/marketplace-orders. Physical shipping is a temporary {formatPkn(CHECKOUT_SHIPPING_PKN)} line.</p>
        </div>
        <Link className="more" to="/cart" style={{ margin: 0 }}>Cart</Link>
      </div>
      <div className="stat-strip">
        <div><strong>{count}</strong><span>Items</span></div>
        <div><strong>{availablePkn.toLocaleString()}</strong><span>Site PKN</span></div>
        <div><strong>{formatPkn(totalPkn)}</strong><span>Due</span></div>
      </div>
      {error ? <p className="status error">{error}</p> : null}
      {orderId ? (
        <p className="lede-copy">
          Paid order {orderId}.{' '}
          <Link to="/orders">View orders</Link>
          {nft ? <> · <Link to="/nft">NFT holdings</Link></> : null}
        </p>
      ) : null}
      {!items.length && !orderId ? (
        <p className="muted">Cart is empty. <Link to="/marketplace">Marketplace</Link></p>
      ) : null}
      {items.length ? (
        <>
          <div className="cart-list">
            {items.map((row) => (
              <article className="cart-row" key={row.id}>
                <Link to={row.href || '/marketplace'} className="cart-art">
                  {row.image ? <CardArt src={row.image} alt="" /> : <span className="suggest-ph" />}
                </Link>
                <div>
                  <strong>{row.name}</strong>
                  <p className="muted">{row.condition} · {row.sellerName} · qty {row.qty}</p>
                </div>
                <strong>{formatPkn((Number(row.pricePkn) || 0) * (Number(row.qty) || 1))}</strong>
              </article>
            ))}
          </div>
          {canNftOnly ? (
            <label className="muted">
              <input type="checkbox" checked={nft} onChange={(event) => setNftOnly(event.target.checked)} />
              NFT only (no physical ship, shipping 0)
            </label>
          ) : (
            <p className="muted">NFT-only checkout needs every row flagged nftAvailable or reserveAvailable.</p>
          )}
          <label className="sell-field">
            Notes
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
          </label>
          <dl className="fee-lines">
            {totals.map(([label, value]) => (
              <div key={label}><dt>{label}</dt><dd>{formatPkn(value)}</dd></div>
            ))}
          </dl>
          {confirm ? (
            <div className="panel site-block">
              <p className="lede-copy">
                {nft
                  ? `Pay ${formatPkn(totalPkn)} from site balance, create one NFT-only order, no physical card ships now.`
                  : `Pay ${formatPkn(totalPkn)} from site balance and notify each seller once.`}
              </p>
              <div className="actions">
                <button className="btn" type="button" disabled={busy} onClick={place}>
                  {busy ? 'Paying…' : 'Confirm order'}
                </button>
                <button className="btn ghost" type="button" onClick={() => setConfirm(false)}>Review again</button>
              </div>
            </div>
          ) : (
            <div className="actions">
              <button className="btn" type="button" disabled={busy || missingListing} onClick={() => setConfirm(true)}>
                Place order
              </button>
              <button className="btn ghost" type="button" onClick={() => navigate('/cart')}>Back to cart</button>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
