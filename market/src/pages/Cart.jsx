import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { formatPkn } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useCart } from '../cart.jsx';
import CardArt from '../components/CardArt.jsx';

export default function Cart() {
  const { items, count, totalPkn, setQty, removeItem, clear } = useCart();
  const { signedIn } = useAuth();

  useEffect(() => {
    document.title = 'Cart · Pokoin';
  }, []);

  return (
    <div className="page app-page">
      <div className="comp-head">
        <div>
          <p className="eyebrow">Shop</p>
          <h1>Cart</h1>
          <p className="muted">{count} item{count === 1 ? '' : 's'} on this browser. Checkout pays site PKN.</p>
        </div>
        {items.length ? (
          <button className="more" type="button" style={{ margin: 0 }} onClick={clear}>Clear</button>
        ) : null}
      </div>
      {!items.length ? (
        <p className="muted">
          Empty. Open a card and tap Add to cart.
          {' '}
          <Link to="/marketplace">Marketplace</Link>
        </p>
      ) : (
        <div className="cart-list">
          {items.map((row) => (
            <article className="cart-row" key={row.id}>
              <Link to={row.href || '/marketplace'} className="cart-art">
                {row.image ? <CardArt src={row.image} alt="" /> : <span className="suggest-ph" />}
              </Link>
              <div>
                <Link to={row.href || '/marketplace'}><strong>{row.name}</strong></Link>
                <p className="muted">{row.condition} · {row.sellerName}</p>
              </div>
              <label className="sell-field cart-qty">
                Qty
                <input
                  inputMode="numeric"
                  value={row.qty}
                  onChange={(event) => setQty(row.id, event.target.value)}
                />
              </label>
              <strong>{formatPkn(row.pricePkn * row.qty)}</strong>
              <button className="linkish" type="button" onClick={() => removeItem(row.id)}>Remove</button>
            </article>
          ))}
          <div className="cart-total">
            <span>Estimated total</span>
            <strong>{formatPkn(totalPkn)}</strong>
          </div>
          {signedIn ? (
            <Link className="btn" to="/checkout">Checkout</Link>
          ) : (
            <Link className="btn" to="/auth?from=/checkout">Sign in to checkout</Link>
          )}
        </div>
      )}
    </div>
  );
}
