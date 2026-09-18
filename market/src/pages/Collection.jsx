import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { requestNftShipping } from '../api.js';
import { firestore, useAuth } from '../auth.jsx';
import { isNftHolding, partitionHoldings } from '../collection-holdings.js';
import { authFrom } from '../punchouts.js';
import { Alert, DeskPanel, EmptyDesk, PageHead, SessionWait } from '../components/Desk.jsx';

function canShip(row) {
  const status = String(row.physicalShippingStatus || '');
  return isNftHolding(row) && (!status || status === 'not_requested');
}

function HoldingRow({ row }) {
  const nft = isNftHolding(row);
  const meta = [
    row.setName,
    row.collectorNumber,
    row.condition,
    row.language,
    nft ? (row.physicalShippingStatus || 'not_requested') : null,
    Number(row.quantity) > 1 ? `×${row.quantity}` : null,
  ].filter(Boolean);
  return (
    <article className="thread" data-ownership={nft ? 'nft' : 'physical'}>
      <span className="thread-main">
        <strong className="thread-title">{row.cardName || row.name || row.cardId}</strong>
        <span className="thread-meta">
          <span className="thread-badge">{nft ? 'NFT' : 'Physical'}</span>
          {meta.length ? ` · ${meta.join(' · ')}` : ''}
        </span>
      </span>
    </article>
  );
}

/**
 * Canonical holdings desk for /collection (physical + NFT).
 * Architecture leaves room for later /collection/:expansionSlug binder overlays.
 */
export default function Collection() {
  const location = useLocation();
  const { ready, signedIn, user, getBearer } = useAuth();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ name: '', line1: '', city: '', postalCode: '', country: '' });

  useEffect(() => {
    document.title = 'Collection · Pokoin';
    if (!user?.uid) {
      setRows(null);
      return undefined;
    }
    const q = query(collection(firestore, 'user_card_collections'), where('uid', '==', user.uid));
    return onSnapshot(q, (snap) => {
      setRows(snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
      setError('');
    }, (err) => setError(err.message || 'Collection failed to load.'));
  }, [user?.uid]);

  const { physical, nft, ownedCards } = useMemo(
    () => partitionHoldings(rows || []),
    [rows],
  );
  const shippable = nft.filter(canShip);

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={authFrom(location.pathname || '/collection')} replace />;
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

  const empty = rows && physical.length === 0 && nft.length === 0;

  return (
    <div className="page desk" data-testid="collection-desk">
      <PageHead
        kicker="Holdings"
        title="Collection"
        lede="Your collection — physical cards you own and NFT holdings. Set binders with owned/missing slots come next."
      >
        <Link className="btn ghost" to="/product/nft">NFT catalog</Link>
        <Link className="btn ghost" to="/scan">Scan cards</Link>
      </PageHead>
      <Alert>{error}</Alert>
      {message ? <p className="desk-ok">{message}</p> : null}
      {rows == null && !error ? (
        <DeskPanel title="Your collection"><div className="skeleton-line" /></DeskPanel>
      ) : null}
      {empty ? (
        <EmptyDesk title="No cards in your collection yet" lede="Scan cards to add them, or checkout an NFT listing.">
          <Link className="btn" to="/scan">Scan cards</Link>
          <Link className="btn ghost" to="/product/nft">Search NFT catalog</Link>
        </EmptyDesk>
      ) : null}
      {rows && !empty ? (
        <div className="wallet-desk">
          <DeskPanel flush title={`${ownedCards} card${ownedCards === 1 ? '' : 's'} owned`}>
            {physical.length ? (
              <div className="thread-list" data-testid="collection-physical">
                <p className="page-lede">Physical · {physical.length} stack{physical.length === 1 ? '' : 's'}</p>
                {physical.map((row) => <HoldingRow key={row.id} row={row} />)}
              </div>
            ) : null}
            {nft.length ? (
              <div className="thread-list" data-testid="collection-nft">
                <p className="page-lede">NFT · {nft.length} holding{nft.length === 1 ? '' : 's'}</p>
                {nft.map((row) => <HoldingRow key={row.id} row={row} />)}
              </div>
            ) : null}
          </DeskPanel>
          {shippable.length ? (
            <form onSubmit={requestAll}>
              <DeskPanel
                title="Request physical shipping (NFT)"
                actions={<button className="btn" type="submit" disabled={busy}>{busy ? 'Sending…' : `Request ${shippable.length}`}</button>}
              >
                <p className="page-lede">NFT holdings only. Does not charge PKN. Stays pending ops review.</p>
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
          ) : nft.length ? (
            <DeskPanel title="NFT shipping">
              <p className="page-lede">No NFT holding is eligible for a shipping request right now.</p>
            </DeskPanel>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
