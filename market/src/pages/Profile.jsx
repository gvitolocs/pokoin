import { useEffect } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { firebaseAuth, useAuth } from '../auth.jsx';
import { useWallet, shortAddress } from '../wallet.jsx';
import { useCart } from '../cart.jsx';
import { DeskPanel, Metric, MetricGrid, PageHead, SessionWait, Thread } from '../components/Desk.jsx';

export default function Profile() {
  const location = useLocation();
  const { user, ready, signedIn, availablePkn, silver, admin, profile } = useAuth();
  const { address, balance } = useWallet();
  const { count } = useCart();

  useEffect(() => {
    document.title = 'Profile · Pokoin';
  }, []);

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={`/auth?from=${encodeURIComponent(location.pathname || '/profile')}`} replace />;
  }

  const silverLine = silver
    ? `Silver${profile?.silverUntil ? ` until ${profile.silverUntil.toISOString?.().slice(0, 10) || profile.silverUntil}` : ''}`
    : 'No Silver on this session. Unlock from a card Best Deal for 20 site PKN.';

  return (
    <div className="page desk">
      <PageHead
        kicker="Account"
        title={user.displayName || user.email || 'Collector'}
        lede={user.email || 'Signed in'}
      >
        <button className="btn ghost" type="button" onClick={() => signOut(firebaseAuth)}>Sign out</button>
      </PageHead>
      <MetricGrid>
        <Metric value={count} label="Cart items" />
        <Metric value={availablePkn.toLocaleString()} label="Site PKN" />
        <Metric value={balance ? balance.toFixed(2) : '0'} label="Chain PKN" />
        <Metric value={address ? shortAddress(address) : '—'} label="Wallet" />
      </MetricGrid>
      <div className="profile-grid">
        <DeskPanel title="Status">
          <p className="page-lede">{silverLine}{admin ? ' · Admin' : ''}</p>
        </DeskPanel>
        <DeskPanel flush title="Go to">
          <div className="thread-list">
            <Thread to="/marketplace/watchlist" title="Watchlist" meta="Local list on this browser" />
            <Thread to="/inventory" title="My listings" meta="Seller inventory" />
            <Thread to="/orders" title="Orders" meta="Paid checkouts" />
            <Thread to="/wallet" title="Wallet" meta="Send, swap, WPKN" />
            <Thread to="/buy" title="Buy PKN" meta="Stripe site balance" />
            <Thread to="/nft" title="NFT holdings" meta="nft_only checkouts" />
            <Thread to="/forum" title="Forum" meta="Community" />
            {admin ? <Thread to="/admin" title="Admin" meta="Expansion logos" /> : null}
          </div>
        </DeskPanel>
      </div>
    </div>
  );
}
