import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { requestNftShipping } from '../api.js';
import { firestore, useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';
import { Alert, DeskPanel, EmptyDesk, PageHead, SessionWait } from '../components/Desk.jsx';

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

  if (!ready) return <SessionWait />;
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
    <div className="page desk">
      <PageHead
        kicker="Holdings"
        title="NFT"
        lede="Owned rows after nft_only checkout. Shipping request is intent-only until a label provider exists."
      >
        <Link className="btn ghost" to="/product/nft">Catalog</Link>
      </PageHead>
      <Alert>{error}</Alert>
      {message ? <p className="desk-ok">{message}</p> : null}
      {rows == null && !error ? (
        <DeskPanel title="Holdings"><div className="skeleton-line" /></DeskPanel>
      ) : null}
      {rows && !nfts.length ? (
        <EmptyDesk title="No NFT holdings" lede="Checkout an nftAvailable listing as NFT only.">
          <Link className="btn" to="/product/nft">Search catalog</Link>
        </EmptyDesk>
      ) : null}
      {nfts.length ? (
        <div className="wallet-desk">
          <DeskPanel flush title={`${nfts.length} holding${nfts.length === 1 ? '' : 's'}`}>
            <div className="thread-list">
              {nfts.map((row) => (
                <article className="thread" key={row.id}>
                  <span className="thread-main">
                    <strong className="thread-title">{row.cardName || row.name || row.cardId}</strong>
                    <span className="thread-meta">
                      {[row.setName, row.collectorNumber, row.physicalShippingStatus || 'not_requested'].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </article>
              ))}
            </div>
          </DeskPanel>
          {shippable.length ? (
            <form onSubmit={requestAll}>
              <DeskPanel
                title="Request physical shipping"
                actions={<button className="btn" type="submit" disabled={busy}>{busy ? 'Sending…' : `Request ${shippable.length}`}</button>}
              >
                <p className="page-lede">Does not charge PKN. Stays pending ops review.</p>
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
              </DeskPanel>
            </form>
          ) : (
            <DeskPanel title="Shipping">
              <p className="page-lede">No holding is eligible for a shipping request right now.</p>
            </DeskPanel>
          )}
        </div>
      ) : null}
    </div>
  );
}
