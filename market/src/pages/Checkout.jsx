import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { createMarketplaceOrder, formatPkn } from '../api.js';
import { useAuth } from '../auth.jsx';
import { CHECKOUT_SHIPPING_PKN, CHECKOUT_TAX_RATE, useCart } from '../cart.jsx';
import { authFrom } from '../punchouts.js';
import CardArt from '../components/CardArt.jsx';
import { Alert, DeskPanel, EmptyDesk, Metric, MetricGrid, PageHead, SessionWait } from '../components/Desk.jsx';

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
    return <SessionWait />;
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
    <div className="page desk">
      <PageHead
        kicker="Shop"
        title="Checkout"
        lede={`Pays site PKN. Physical shipping is a temporary ${formatPkn(CHECKOUT_SHIPPING_PKN)} line until a rate API exists.`}
      >
        <Link className="btn ghost" to="/cart">Cart</Link>
      </PageHead>
      <MetricGrid>
        <Metric value={count} label="Items" />
        <Metric value={availablePkn.toLocaleString()} label="Site PKN" />
        <Metric value={formatPkn(totalPkn)} label="Due" />
      </MetricGrid>
      <Alert>{error}</Alert>
      {orderId ? (
        <p className="desk-ok">
          Paid order {orderId}.{' '}
          <Link to="/orders">View orders</Link>
          {nft ? <> · <Link to="/nft">NFT holdings</Link></> : null}
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
                  <Link to={row.href || '/marketplace'} className="bag-art">
                    {row.image ? <CardArt src={row.image} alt="" /> : <span className="suggest-ph" />}
                  </Link>
                  <div className="bag-info">
                    <strong className="bag-name">{row.name}</strong>
                    <p className="bag-seller">{row.condition} · {row.sellerName} · qty {row.qty}</p>
                  </div>
                  <strong className="bag-price">{formatPkn((Number(row.pricePkn) || 0) * (Number(row.qty) || 1))}</strong>
                </article>
              ))}
            </div>
            {canNftOnly ? (
              <label className="page-lede">
                <input type="checkbox" checked={nft} onChange={(event) => setNftOnly(event.target.checked)} />
                {' '}NFT only — no physical ship, shipping 0
              </label>
            ) : (
              <p className="page-lede">NFT-only checkout needs every row flagged nftAvailable or reserveAvailable.</p>
            )}
            <label className="sell-field">
              Notes
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
            </label>
          </DeskPanel>
          <DeskPanel
            title="Pay"
            actions={confirm ? (
              <>
                <button className="btn" type="button" disabled={busy} onClick={place}>
                  {busy ? 'Paying…' : 'Confirm order'}
                </button>
                <button className="btn ghost" type="button" onClick={() => setConfirm(false)}>Review again</button>
              </>
            ) : (
              <>
                <button className="btn" type="button" disabled={busy || missingListing} onClick={() => setConfirm(true)}>
                  Place order
                </button>
                <button className="btn ghost" type="button" onClick={() => navigate('/cart')}>Back to cart</button>
              </>
            )}
          >
            <dl className="fee-lines">
              {totals.map(([label, value]) => (
                <div key={label}><dt>{label}</dt><dd>{formatPkn(value)}</dd></div>
              ))}
            </dl>
            {confirm ? (
              <p className="page-lede">
                {nft
                  ? `Pay ${formatPkn(totalPkn)} from site balance, create one NFT-only order, no physical card ships now.`
                  : `Pay ${formatPkn(totalPkn)} from site balance and notify each seller once.`}
              </p>
            ) : null}
            {missingListing ? <Alert>A cart row is missing listingId. Add the offer from Shop again.</Alert> : null}
          </DeskPanel>
        </div>
      ) : null}
    </div>
  );
}
