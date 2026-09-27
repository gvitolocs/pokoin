import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { formatPkn } from '../api.js';
import { looseCardReference, writeListingDrag } from '../chat-listing.js';
import { useAuth } from '../auth.jsx';
import { useCart } from '../cart.jsx';
import { formatEurAndDkkFromPkn } from '../pkn.js';
import CardArt from '../components/CardArt.jsx';
import { DeskPanel, EmptyDesk, PageHead } from '../components/Desk.jsx';

export default function Cart() {
  const { items, count, totalPkn, setQty, removeItem, clear } = useCart();
  const { signedIn, availablePkn } = useAuth();
  const canPayWithPkn = Number(availablePkn) >= Number(totalPkn);
  const showFiat = signedIn && !canPayWithPkn && totalPkn > 0;

  useEffect(() => {
    document.title = 'Cart · Pokoin';
  }, []);

  return (
    <div className="page desk">
      <PageHead
        kicker="Shop"
        title="Cart"
        lede={showFiat
          ? `${count} ${count === 1 ? 'item' : 'items'} — site PKN is short, so totals show in EUR / DKK for Stripe checkout.`
          : `${count} ${count === 1 ? 'item' : 'items'} on this browser. Checkout pays with site PKN or Stripe (EUR).`}
      >
        {items.length ? <button className="btn ghost" type="button" onClick={clear}>Clear</button> : null}
        <Link className="btn ghost" to="/marketplace">Keep shopping</Link>
      </PageHead>

      {!items.length ? (
        <EmptyDesk icon="cart" title="Cart is empty" lede="Open a card desk and add a native listing from Shop.">
          <Link className="btn" to="/marketplace">Browse marketplace</Link>
        </EmptyDesk>
      ) : (
        <DeskPanel
          flush
          title="Items"
          actions={(
            signedIn
              ? <Link className="btn" to="/checkout">Checkout</Link>
              : <Link className="btn" to="/auth?from=/checkout">Sign in to checkout</Link>
          )}
        >
          <div className="bag-list">
            {items.map((row) => (
              <article className="bag-row" key={row.id}>
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
                  <Link className="bag-name" to={row.href || '/marketplace'}>{row.name}</Link>
                  <p className="bag-seller">{row.condition} · {row.sellerName}</p>
                </div>
                <label className="bag-qty">
                  <span className="sr-only">Qty</span>
                  <input inputMode="numeric" max={row.stock || 1} value={row.qty} onChange={(event) => setQty(row.id, event.target.value)} />
                </label>
                <strong className="bag-price">
                  {showFiat
                    ? formatEurAndDkkFromPkn(row.pricePkn * row.qty)
                    : formatPkn(row.pricePkn * row.qty)}
                </strong>
                <button className="bag-remove" type="button" onClick={() => removeItem(row.id)}>Remove</button>
              </article>
            ))}
          </div>
          <div className="bag-total">
            <span className="page-lede" style={{ maxWidth: 'none' }}>
              {showFiat ? 'Estimated (EUR · DKK)' : 'Estimated total'}
            </span>
            <strong>{showFiat ? formatEurAndDkkFromPkn(totalPkn) : formatPkn(totalPkn)}</strong>
          </div>
        </DeskPanel>
      )}
    </div>
  );
}
