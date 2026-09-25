import { Suspense, lazy, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { firebaseAuth, getBearer, useAuth } from '../auth.jsx';
import { endActiveScanSessionForSignOut } from '../scan-api.js';
import { accountHeading, accountLede } from '../auth-session.js';
import { useWallet, shortAddress } from '../wallet.jsx';
import { useCart } from '../cart.jsx';
import { DeskPanel, Metric, MetricGrid, PageHead, SessionWait, Thread } from '../components/Desk.jsx';
import CardTraderConnectPanel from '../components/CardTraderConnectPanel.jsx';
import { formatPknNumber } from '../pkn.js';
import Avatar from '../components/Avatar.jsx';

// The cropper (react-easy-crop) loads only when someone edits their photo.
const AvatarEditor = lazy(() => import('../components/AvatarEditor.jsx'));

function googlePhotoOf(user) {
  const google = (user?.providerData || []).find((row) => row?.providerId === 'google.com');
  return String(google?.photoURL || '').trim();
}

export default function Profile() {
  const location = useLocation();
  const { user, ready, signedIn, availablePkn, silver, admin, profile } = useAuth();
  const { address, balance } = useWallet();
  const { count } = useCart();
  const [editing, setEditing] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    document.title = 'Profile · Pokoin';
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(''), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={`/auth?from=${encodeURIComponent(location.pathname || '/profile')}`} replace />;
  }

  const silverLine = silver
    ? `Silver${profile?.silverUntil ? ` until ${profile.silverUntil.toISOString?.().slice(0, 10) || profile.silverUntil}` : ''}`
    : 'No Silver on this session. Unlock from a card Best Deal for 20 site PKN.';

  const name = accountHeading(user, profile);
  const photoUrl = profile?.photoUrl || '';

  return (
    <div className="page desk">
      <PageHead
        kicker="Account"
        title={name}
        lede={accountLede(user)}
        leading={(
          <button
            className="profile-avatar-button"
            type="button"
            onClick={() => setEditing(true)}
            aria-label={photoUrl ? 'Change profile photo' : 'Add a profile photo'}
            title={photoUrl ? 'Change profile photo' : 'Add a profile photo'}
          >
            <Avatar src={photoUrl} name={name} size={88} silver={silver} />
            <span className="profile-avatar-badge" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9Zm3 5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" /></svg>
            </span>
          </button>
        )}
      >
        <button
          className="btn ghost"
          type="button"
          onClick={async () => {
            await endActiveScanSessionForSignOut(getBearer);
            await signOut(firebaseAuth);
          }}
        >
          Sign out
        </button>
      </PageHead>
      {toast ? <p className="profile-toast" role="status">{toast}</p> : null}
      {editing ? (
        <Suspense fallback={null}>
          <AvatarEditor
            open
            onClose={() => setEditing(false)}
            onSaved={setToast}
            name={name}
            photoUrl={photoUrl}
            googlePhotoUrl={googlePhotoOf(user)}
          />
        </Suspense>
      ) : null}
      <MetricGrid>
        <Metric value={count} label="Cart items" />
        <Metric value={formatPknNumber(availablePkn)} label="Site PKN" />
        <Metric value={balance ? balance.toFixed(2) : '0'} label="Chain PKN" />
        <Metric value={address ? shortAddress(address) : '—'} label="Wallet" />
      </MetricGrid>
      <div className="profile-grid">
        <DeskPanel title="Status">
          <p className="page-lede">{silverLine}{admin ? ' · Admin' : ''}</p>
        </DeskPanel>
        <DeskPanel title="CardTrader">
          <CardTraderConnectPanel />
        </DeskPanel>
        <DeskPanel flush title="Go to">
          <div className="thread-list">
            <Thread to="/marketplace/watchlist" title="Watchlist" meta="Local list on this browser" />
            <Thread to="/inventory" title="My listings" meta="Seller inventory" />
            <Thread to="/orders" title="Orders" meta="Paid checkouts" />
            <Thread to="/wallet" title="Wallet" meta="Send, swap, WPKN" />
            <Thread to="/buy" title="Buy PKN" meta="Stripe site balance" />
            <Thread to="/collection" title="Your collection" meta="Physical + NFT holdings" />
            <Thread to="/forum" title="Forum" meta="Community" />
            {admin ? <Thread to="/admin" title="Admin" meta="Expansion logos" /> : null}
          </div>
        </DeskPanel>
      </div>
    </div>
  );
}
