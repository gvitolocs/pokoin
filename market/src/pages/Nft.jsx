import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { requestNftShipping } from '../api.js';
import { firestore, useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';

function isNft(row) {
  return row.ownershipType === 'nft' || row.fulfillmentMode === 'nft_only' || row.nftStatus === 'owned';
}

function canShip(row) {
  const status = String(row.physicalShippingStatus || '');
  return isNft(row) && (!status || status === 'not_requested');
}

export default function Nft() {
  const location = useLocation();
  const { ready, signedIn, user, getBearer } = useAuth();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ name: '', line1: '', city: '', postalCode: '', country: '' });

  useEffect(() => {
    document.title = 'NFT · Pokoin';
    if (!user?.uid) {
      setRows(null);
      return undefined;
    }
    const q = query(collection(firestore, 'user_card_collections'), where('uid', '==', user.uid));
    return onSnapshot(q, (snap) => {
      setRows(snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
      setError('');
    }, (err) => setError(err.message || 'NFT collection failed.'));
  }, [user?.uid]);

  const nfts = useMemo(() => (rows || []).filter(isNft), [rows]);
  const shippable = nfts.filter(canShip);

  if (!ready) {
    return <div className="page"><p className="muted">Checking session…</p></div>;
  }
  if (!signedIn) {
    return <Navigate to={authFrom(location.pathname || '/nft')} replace />;
  }

  async function requestAll(event) {
    event.preventDefault();
    if (!shippable.length) {
      setError('No NFT is eligible for a shipping request.');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const token = await getBearer();
      const data = await requestNftShipping({
        collectionItemIds: shippable.map((row) => row.id),
        shippingAddress: form,
      }, token);
      setMessage(data.message || `Requested ${data.requests?.length || shippable.length} shipment${shippable.length === 1 ? '' : 's'}.`);
    } catch (err) {
      setError(err.message || 'Shipping request failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page app-page">
      <div className="comp-head">
        <div>
          <p className="eyebrow">Holdings</p>
          <h1>NFT</h1>
          <p className="muted">Owned rows from user_card_collections after nft_only checkout. Shipping request is intent-only.</p>
        </div>
        <Link className="more" to="/product/nft" style={{ margin: 0 }}>Catalog</Link>
      </div>
      {error ? <p className="status error">{error}</p> : null}
      {message ? <p className="lede-copy">{message}</p> : null}
      {rows == null && !error ? <p className="muted">Loading NFTs…</p> : null}
      {rows && !nfts.length ? (
        <p className="muted">No NFT holdings. Checkout an nftAvailable listing as NFT only. <Link to="/product/nft">Search catalog</Link></p>
      ) : (
        <div className="forum-list">
          {nfts.map((row) => (
            <article className="forum-row" key={row.id}>
              <strong>{row.cardName || row.name || row.cardId}</strong>
              <span className="muted">
                {row.setName || ''} {row.collectorNumber || ''} · {row.physicalShippingStatus || 'not_requested'}
              </span>
            </article>
          ))}
        </div>
      )}
      {shippable.length ? (
        <form className="panel auth-card" onSubmit={requestAll}>
          <h2>Request physical shipping</h2>
          <p className="muted">Does not charge PKN. Stays pending ops review until a label provider exists.</p>
          {['name', 'line1', 'city', 'postalCode', 'country'].map((key) => (
            <label className="sell-field" key={key}>
              {key}
              <input
                required
                value={form[key]}
                onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
              />
            </label>
          ))}
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Sending…' : `Request ${shippable.length}`}
          </button>
        </form>
      ) : null}
    </div>
  );
}
