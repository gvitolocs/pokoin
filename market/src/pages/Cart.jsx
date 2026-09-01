import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { formatPkn } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useCart } from '../cart.jsx';
import CardArt from '../components/CardArt.jsx';
import { DeskPanel, EmptyDesk, PageHead } from '../components/Desk.jsx';

export default function Cart() {
  const { items, count, totalPkn, setQty, removeItem, clear } = useCart();
  const { signedIn } = useAuth();

  useEffect(() => {
    document.title = 'Cart · Pokoin';
  }, []);

  return (
    <div className="page desk">
      <PageHead
        kicker="Shop"
        title="Cart"
        lede={`${count} ${count === 1 ? 'item' : 'items'} on this browser. Checkout pays site PKN, not chain PKN.`}
      >
        {items.length ? <button className="btn ghost" type="button" onClick={clear}>Clear</button> : null}
        <Link className="btn ghost" to="/marketplace">Keep shopping</Link>
      </PageHead>

      {!items.length ? (
        <EmptyDesk title="Cart is empty" lede="Open a card desk and add a native listing from Shop.">
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
                <Link to={row.href || '/marketplace'} className="bag-art">
                  {row.image ? <CardArt src={row.image} alt="" /> : <span className="suggest-ph" />}
                </Link>
                <div className="bag-info">
                  <Link className="bag-name" to={row.href || '/marketplace'}>{row.name}</Link>
                  <p className="bag-seller">{row.condition} · {row.sellerName}</p>
                </div>
                <label className="bag-qty">
                  <span className="sr-only">Qty</span>
                  <input inputMode="numeric" value={row.qty} onChange={(event) => setQty(row.id, event.target.value)} />
                </label>
                <strong className="bag-price">{formatPkn(row.pricePkn * row.qty)}</strong>
                <button className="bag-remove" type="button" onClick={() => removeItem(row.id)}>Remove</button>
              </article>
            ))}
          </div>
          <div className="bag-total">
            <span className="page-lede" style={{ maxWidth: 'none' }}>Estimated total</span>
            <strong>{formatPkn(totalPkn)}</strong>
          </div>
        </DeskPanel>
      )}
    </div>
  );
}
