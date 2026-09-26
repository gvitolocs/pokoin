import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { createMarketplaceOrder, formatPkn, formatPknNumber } from '../api.js';
import { ESCROW_LINE, NO_SHIP_GUARANTEE } from '../buyer-protection.js';
import { useAuth } from '../auth.jsx';
import { CHECKOUT_SHIPPING_PKN, useCart } from '../cart.jsx';
import { checkoutFees } from '../checkout-fees.js';
import { looseCardReference, writeListingDrag } from '../chat-listing.js';
import { authFrom } from '../punchouts.js';
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

  const nft = nftOnly && canNftOnly;
  const shippingPkn = nft ? 0 : (items.length ? CHECKOUT_SHIPPING_PKN : 0);
  const fees = checkoutFees(subtotalPkn, { insurance: insurance && !nft, shippingPkn });
  const { commissionPkn, insurancePkn, taxPkn, totalPkn, coveragePkn } = fees;
  const missingListing = items.some((row) => !row.listingId);

  useEffect(() => {
    document.title = 'Checkout · Pokoin';
  }, []);

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
        lede={nft
          ? 'You pay with your site balance and the cards go into your collection. Nothing is mailed.'
          : `${ESCROW_LINE} ${NO_SHIP_GUARANTEE}`}
      >
        <Link className="btn ghost" to="/cart">Cart</Link>
        {nft ? null : <Link className="btn ghost" to="/protection">Buyer protection</Link>}
      </PageHead>
      <MetricGrid>
        <Metric value={count} label="Items" />
        <Metric value={formatPknNumber(availablePkn)} label="Site PKN" />
        <Metric value={formatPkn(totalPkn)} label="Due" />
      </MetricGrid>
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
                  <strong className="bag-price">{formatPkn((Number(row.pricePkn) || 0) * (Number(row.qty) || 1))}</strong>
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
                These cards will be mailed to you. You can skip shipping only when every card in the cart can stay digital instead of being sent in the mail.
              </p>
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
            {confirm ? (
              <p className="page-lede">
                {nft
                  ? `Pay ${formatPkn(totalPkn)} from your site balance. The cards go into your collection. Nothing is mailed.`
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
