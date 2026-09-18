import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { fetchOwnedCollection, removeCollectionItem, requestNftShipping } from '../api.js';
import { useAuth } from '../auth.jsx';
import { isNftHolding, partitionHoldings } from '../collection-holdings.js';
import { authFrom } from '../punchouts.js';
import { Alert, DeskPanel, EmptyDesk, PageHead, SessionWait } from '../components/Desk.jsx';

function canShip(row) {
  const status = String(row.physicalShippingStatus || '');
  return isNftHolding(row) && (!status || status === 'not_requested');
}

function HoldingRow({ row, onRemove, removing }) {
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
      {onRemove ? (
        <button
          type="button"
          className="thread-remove"
          data-testid="collection-remove"
          aria-label={`Remove ${row.cardName || row.name || row.cardId} from collection`}
          title="Remove from collection"
          disabled={removing}
          onClick={() => onRemove(row)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      ) : null}
    </article>
  );
}

/**
 * Canonical holdings desk for /collection (physical + NFT).
 * Loads via authenticated BFF — never client Firestore (no rules match).
 */
export default function Collection() {
  const location = useLocation();
  const { ready, signedIn, user, profile, getBearer } = useAuth();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ name: '', line1: '', city: '', postalCode: '', country: '' });
  const [removingId, setRemovingId] = useState(null);

  const loadCollection = useCallback(async () => {
    setRows(null);
    setError('');
    try {
      const token = await getBearer();
      const data = await fetchOwnedCollection(token);
      setRows(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      console.error('collection load failed', err);
      setError("Couldn't load your collection");
      setRows([]);
    }
  }, [getBearer]);

  useEffect(() => {
    document.title = 'Collection · Pokoin';
    if (!signedIn) {
      setRows(null);
      return undefined;
    }
    let cancelled = false;
    setRows(null);
    setError('');
    getBearer()
      .then((token) => fetchOwnedCollection(token))
      .then((data) => {
        if (cancelled) return;
        setRows(Array.isArray(data.items) ? data.items : []);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('collection load failed', err);
        setError("Couldn't load your collection");
        setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, user?.uid, profile?.uid, getBearer]);

  const { physical, nft, ownedCards } = useMemo(
    () => partitionHoldings(rows || []),
    [rows],
  );
  const shippable = nft.filter(canShip);

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={authFrom(location.pathname || '/collection')} replace />;
  }

  async function removeItem(row) {
    if (removingId) return;
    setRemovingId(row.id);
    setError('');
    setMessage('');
    try {
      const token = await getBearer();
      const result = await removeCollectionItem({ itemId: row.id }, token);
      setRows((current) => (current || [])
        .map((r) => (r.id === row.id ? { ...r, quantity: result.after } : r))
        .filter((r) => !(r.id === row.id && result.deleted)));
      if (result.deleted) {
        setMessage(`Removed ${row.cardName || row.name || row.cardId} from your collection.`);
      }
    } catch (err) {
      console.error('collection remove failed', err);
      setError("Couldn't remove the card. Try again.");
    } finally {
      setRemovingId(null);
    }
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
      await loadCollection();
    } catch (err) {
      console.error('NFT shipping request failed', err);
      setError("Couldn't request shipping. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const empty = rows && physical.length === 0 && nft.length === 0 && !error;
  const loading = rows == null && !error;

  return (
    <div className="page desk" data-testid="collection-desk">
      <PageHead
        kicker="Holdings"
        title="Collection"
      >
        <Link className="btn ghost" to="/product/nft">NFT catalog</Link>
        <Link className="btn ghost" to="/scan">Scan cards</Link>
      </PageHead>
      {error ? (
        <div className="desk-panel" data-testid="collection-error">
          <Alert>{error}</Alert>
          <button type="button" className="btn ghost" onClick={() => { void loadCollection(); }} data-testid="collection-retry">
            Retry
          </button>
        </div>
      ) : null}
      {message ? <p className="desk-ok">{message}</p> : null}
      {loading ? (
        <DeskPanel title="Your collection"><div className="skeleton-line" /></DeskPanel>
      ) : null}
      {empty ? (
        <EmptyDesk title="No cards in your collection yet" lede="Scan cards to add them, or checkout an NFT listing.">
          <Link className="btn" to="/scan">Scan cards</Link>
          <Link className="btn ghost" to="/product/nft">Search NFT catalog</Link>
        </EmptyDesk>
      ) : null}
      {rows && !empty && !error ? (
        <div className="wallet-desk">
          <DeskPanel flush title={`${ownedCards} card${ownedCards === 1 ? '' : 's'} owned`}>
            {physical.length ? (
              <div className="thread-list" data-testid="collection-physical">
                <p className="page-lede">Physical · {physical.length} stack{physical.length === 1 ? '' : 's'}</p>
                {physical.map((row) => (
                  <HoldingRow
                    key={row.id}
                    row={row}
                    onRemove={removeItem}
                    removing={removingId === row.id}
                  />
                ))}
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
