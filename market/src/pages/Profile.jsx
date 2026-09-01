import { useEffect } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { firebaseAuth, useAuth } from '../auth.jsx';
import { useWallet, shortAddress } from '../wallet.jsx';
import { useCart } from '../cart.jsx';

export default function Profile() {
  const location = useLocation();
  const { user, ready, signedIn, availablePkn, silver, admin, profile } = useAuth();
  const { address, balance } = useWallet();
  const { count } = useCart();

  useEffect(() => {
    document.title = 'Profile · Pokoin';
  }, []);

  if (!ready) {
    return <div className="page"><p className="muted">Checking session…</p></div>;
  }
  if (!signedIn) {
    return <Navigate to={`/auth?from=${encodeURIComponent(location.pathname || '/profile')}`} replace />;
  }

  return (
    <div className="page app-page">
      <div className="comp-head">
        <div>
          <p className="eyebrow">Account</p>
          <h1>{user.displayName || user.email || 'Collector'}</h1>
          <p className="muted">{user.email}</p>
        </div>
        <button
          className="more"
          type="button"
          style={{ margin: 0 }}
          onClick={() => signOut(firebaseAuth)}
        >
          Sign out
        </button>
      </div>
      <div className="stat-strip">
        <div><strong>{count}</strong><span>Cart items</span></div>
        <div><strong>{availablePkn.toLocaleString()}</strong><span>Site PKN</span></div>
        <div><strong>{balance ? balance.toFixed(2) : '0'}</strong><span>PKN on chain</span></div>
        <div><strong>{address ? shortAddress(address) : '—'}</strong><span>Wallet</span></div>
      </div>
      <p className="muted">
        {silver
          ? `Silver${profile?.silverUntil ? ` until ${profile.silverUntil.toISOString?.().slice(0, 10) || profile.silverUntil}` : ''}`
          : 'No Silver on this session. Unlock from a card Best Deal for 20 site PKN.'}
        {admin ? ' · Admin' : ''}
      </p>
      <nav className="link-list">
        <Link to="/marketplace/watchlist">Watchlist</Link>
        <Link to="/inventory">My listings</Link>
        <Link to="/cart">Cart</Link>
        <Link to="/checkout">Checkout</Link>
        <Link to="/orders">Orders</Link>
        <Link to="/wallet">Wallet</Link>
        <Link to="/buy">Buy PKN</Link>
        <Link to="/nft">NFT holdings</Link>
        <Link to="/marketplace/portfolio">Portfolio dump</Link>
        <Link to="/forum">Forum</Link>
        {admin ? <Link to="/admin">Admin</Link> : null}
      </nav>
    </div>
  );
}
