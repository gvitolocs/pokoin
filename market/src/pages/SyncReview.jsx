import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import {
  cancelListing,
  createListing,
  fetchCardTraderSyncStatus,
  fetchSearch,
  fetchSellerListings,
  fetchSellerSettings,
  formatPkn,
  updateListing,
} from '../api.js';
import { useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';
import { GAMES } from '../game.js';
import { Alert, DeskPanel, EmptyDesk, PageHead, SessionWait } from '../components/Desk.jsx';
import StockNav from '../components/StockNav.jsx';

const GAME_LABEL = Object.fromEntries(
  Object.values(GAMES).map((game) => [game.id, game.name]),
);

function gameName(id) {
  return GAME_LABEL[id] || id;
}

function ctSourceId(productId) {
  return `ct:${String(productId || '').trim()}`;
}

function compactCn(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^.*\|\s*/, '')
    .replace(/\s+/g, '')
    .replace(/^0+(\d)/, '$1');
}

function ptRowKey(row, index) {
  return `pt:${row.game}:${row.name}:${row.collectorNumber}:${row.condition}:${row.language}:${row.reverse ? 1 : 0}:${index}`;
}

/** Pick a catalog printing that matches name + collector number from search hits. */
function pickCardFromSearch(data, row) {
  const cards = data?.cards || data?.items || data?.results || [];
  const wantName = String(row.name || '').trim().toLowerCase();
  const wantCn = compactCn(row.collectorNumber);
  const scored = cards
    .map((card) => {
      const id = String(card.id || card.cardId || card.card_id || '');
      const name = String(card.name || card.cardName || '').trim().toLowerCase();
      const cn = compactCn(card.collectorNumber || card.cardNumber || card.number || '');
      let score = 0;
      if (id && name === wantName) score += 4;
      if (id && wantCn && (cn === wantCn || cn.startsWith(`${wantCn}/`) || cn.includes(`|${wantCn}`))) score += 4;
      if (id && wantCn && cn.includes(wantCn)) score += 1;
      return { card, id, score };
    })
    .filter((hit) => hit.id && hit.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.card || null;
}

export default function SyncReview() {
  const location = useLocation();
  const { ready, signedIn, user, profile, getBearer } = useAuth();
  const uid = user?.uid || profile?.uid || '';
  const sellerName = profile?.username || profile?.displayName || user?.displayName || 'Pokoin seller';
  const [reconcile, setReconcile] = useState(null);
  const [listings, setListings] = useState([]);
  const [shipFromCountry, setShipFromCountry] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [locations, setLocations] = useState({});
  const [dismissedPt, setDismissedPt] = useState(() => new Set());

  useEffect(() => {
    document.title = 'CardTrader ↔ Power Tools · Pokoin';
    if (!signedIn || !uid) return undefined;
    let cancelled = false;
    getBearer()
      .then(async (token) => {
        const [syncData, listData, settings] = await Promise.all([
          fetchCardTraderSyncStatus(token),
          fetchSellerListings(uid, token, { limit: 1000 }),
          fetchSellerSettings(token).catch(() => ({})),
        ]);
        if (cancelled) return;
        const summary = syncData?.sync?.summary || syncData?.summary || {};
        setReconcile(summary.powerToolsReconcile || null);
        setListings(listData?.listings || listData?.items || []);
        setShipFromCountry(String(settings?.shipFromCountry || '').toUpperCase());
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Could not load sync review.');
      });
    return () => { cancelled = true; };
  }, [signedIn, uid, getBearer]);

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={authFrom(location.pathname || '/inventory/sync-review')} replace />;
  }

  const ctOnly = reconcile?.ctOnly || [];
  const ptOnly = (reconcile?.ptOnly || []).filter((_, index) => !dismissedPt.has(index));

  function listingForCtProduct(productId) {
    const source = ctSourceId(productId);
    return listings.find((row) => String(row.sourceListingId || row.source_listing_id || '') === source) || null;
  }

  async function saveCtLocation(row) {
    const key = `ct:${row.ctProductId}`;
    const locationValue = String(locations[key] || '').trim();
    if (!locationValue) {
      setError('Enter a location first.');
      return;
    }
    const listing = listingForCtProduct(row.ctProductId);
    if (!listing?.id) {
      setError('No Pokoin listing linked to that CardTrader product yet. Sync again or open the card desk.');
      return;
    }
    setBusyKey(key);
    setError('');
    try {
      const token = await getBearer();
      await updateListing(listing.id, { location: locationValue }, token);
      setListings((prev) => prev.map((item) => (
        item.id === listing.id ? { ...item, location: locationValue } : item
      )));
      setMessage(`Saved location ${locationValue} on ${row.name || row.ctProductId}.`);
    } catch (err) {
      setError(err.message || 'Could not update location.');
    } finally {
      setBusyKey('');
    }
  }

  async function removeCtListing(row) {
    const key = `cancel:${row.ctProductId}`;
    const listing = listingForCtProduct(row.ctProductId);
    if (!listing?.id) {
      setError('No Pokoin listing to cancel for that CardTrader product.');
      return;
    }
    setBusyKey(key);
    setError('');
    try {
      const token = await getBearer();
      await cancelListing(listing.id, token, uid);
      setListings((prev) => prev.filter((item) => item.id !== listing.id));
      setReconcile((prev) => (prev ? {
        ...prev,
        ctOnly: (prev.ctOnly || []).filter((item) => item.ctProductId !== row.ctProductId),
      } : prev));
      setMessage(`Cancelled Pokoin listing for ${row.name || row.ctProductId}.`);
    } catch (err) {
      setError(err.message || 'Could not cancel listing.');
    } finally {
      setBusyKey('');
    }
  }

  async function listPtOnly(row, index) {
    const key = ptRowKey(row, index);
    if (!shipFromCountry) {
      setError('Set ship-from country on Profile before listing Power Tools-only cards.');
      return;
    }
    const locationValue = String(locations[key] ?? row.location ?? '').trim();
    const pricePkn = Math.max(1, Math.trunc(Number(row.pricePkn) || 0));
    if (!(pricePkn > 0)) {
      setError('That Power Tools row has no price. Open the card desk to list it manually.');
      return;
    }
    setBusyKey(key);
    setError('');
    try {
      const token = await getBearer();
      const query = [row.name, row.collectorNumber].filter(Boolean).join(' ').trim();
      const search = await fetchSearch({ query, limit: 24, productType: 'card' });
      const card = pickCardFromSearch(search, row);
      const cardId = String(card?.id || card?.cardId || '');
      if (!cardId) {
        setError(`No catalog match for ${row.name || 'card'} ${row.collectorNumber || ''}. Use Add via scan.`);
        return;
      }
      const created = await createListing({
        cardId,
        sellerName,
        sellerCountry: shipFromCountry,
        shipFromCountry,
        sellerReputationLabel: 'New',
        condition: row.condition || 'NM',
        language: row.language || 'EN',
        pricePkn,
        quantityAvailable: Math.max(1, Math.trunc(Number(row.quantity) || 1)),
        reverse: row.reverse === true,
        firstEdition: row.firstEdition === true,
        foilState: row.reverse === true ? 'reverse' : 'standard',
        location: locationValue,
        source: 'powertools_sync_review',
        sourceListingId: `pt-review:${row.game}:${cardId}:${row.condition}:${row.language}:${row.reverse ? 1 : 0}:${locationValue}`.slice(0, 160),
        cardName: card.name || row.name,
        setName: card.setName || card.set || row.setName || '',
        collectorNumber: card.collectorNumber || card.number || row.collectorNumber || '',
        marketplaceGame: row.game || 'pokemon',
        targets: { pokoin: true, cardtrader: false },
      }, token);
      const listing = created?.listing || created;
      if (listing?.id) {
        setListings((prev) => [listing, ...prev]);
      }
      setDismissedPt((prev) => new Set(prev).add(index));
      setMessage(`Listed ${row.name || cardId} on Pokoin${locationValue ? ` at ${locationValue}` : ''}.`);
    } catch (err) {
      setError(err.message || 'Could not list that Power Tools card.');
    } finally {
      setBusyKey('');
    }
  }

  function dismissPtOnly(index) {
    setDismissedPt((prev) => new Set(prev).add(index));
    setMessage('Skipped that Power Tools-only row.');
  }

  return (
    <div className="page desk">
      <PageHead
        kicker="Seller"
        title="CardTrader ↔ Power Tools"
        lede="Cards only on CardTrader or only in Power Tools after the last sync. Set a stock location, list them, or remove Pokoin listings."
      >
        <Link className="btn ghost" to="/mypokoin">MyPokoin</Link>
        <Link className="btn ghost" to="/profile">Profile</Link>
      </PageHead>
      <StockNav />
      <Alert>{error}</Alert>
      {message ? <p className="ct-connect-ok">{message}</p> : null}

      {!reconcile ? (
        <DeskPanel title="Review">
          <p className="page-lede muted">
            No Power Tools mismatch from the last sync. Run Sync CardTrader from Profile with Power Tools CSVs first.
          </p>
        </DeskPanel>
      ) : null}

      {reconcile ? (
        <DeskPanel title="Summary">
          <p className="page-lede">
            Matched {Number(reconcile.matched || 0)}
            {' · '}
            locations applied {Number(reconcile.locationsApplied || 0)}
            {' · '}
            CardTrader-only {ctOnly.length}
            {' · '}
            Power Tools-only {ptOnly.length}
          </p>
        </DeskPanel>
      ) : null}

      {ctOnly.length ? (
        <DeskPanel flush title={`On CardTrader, not in Power Tools (${ctOnly.length})`}>
          <div className="thread-list">
            {ctOnly.map((row) => {
              const key = `ct:${row.ctProductId}`;
              const listing = listingForCtProduct(row.ctProductId);
              return (
                <article className="thread order-row" key={key}>
                  <span className="thread-main">
                    <strong className="thread-title">{row.name || row.ctProductId}</strong>
                    <span className="thread-meta">
                      {gameName(row.game)}
                      {' · '}
                      {row.condition} {row.language}
                      {row.reverse ? ' · reverse' : ''}
                      {' · '}
                      qty {row.quantity}
                      {row.pricePkn ? ` · ${formatPkn(row.pricePkn)}` : ''}
                      {listing?.location ? ` · now ${listing.location}` : ''}
                    </span>
                    <label className="ct-pt-inline">
                      Location
                      <input
                        type="text"
                        placeholder="box1·3"
                        value={locations[key] ?? listing?.location ?? ''}
                        disabled={Boolean(busyKey)}
                        onChange={(event) => setLocations((prev) => ({ ...prev, [key]: event.target.value }))}
                      />
                    </label>
                  </span>
                  <span className="order-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={Boolean(busyKey)}
                      onClick={() => saveCtLocation(row)}
                    >
                      {busyKey === key ? 'Saving…' : 'Save location'}
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={Boolean(busyKey) || !listing?.id}
                      onClick={() => removeCtListing(row)}
                    >
                      {busyKey === `cancel:${row.ctProductId}` ? 'Removing…' : 'Cancel listing'}
                    </button>
                    {row.cardId ? (
                      <Link className="btn ghost" to={`/marketplace/en/cards/${row.cardId}`}>
                        Open card
                      </Link>
                    ) : null}
                  </span>
                </article>
              );
            })}
          </div>
        </DeskPanel>
      ) : null}

      {ptOnly.length ? (
        <DeskPanel flush title={`In Power Tools, not on CardTrader (${ptOnly.length})`}>
          <div className="thread-list">
            {(reconcile?.ptOnly || []).map((row, index) => {
              if (dismissedPt.has(index)) return null;
              const key = ptRowKey(row, index);
              return (
                <article className="thread order-row" key={key}>
                  <span className="thread-main">
                    <strong className="thread-title">{row.name || 'Card'}</strong>
                    <span className="thread-meta">
                      {gameName(row.game)}
                      {row.setName ? ` · ${row.setName}` : ''}
                      {row.collectorNumber ? ` · ${row.collectorNumber}` : ''}
                      {' · '}
                      {row.condition} {row.language}
                      {row.reverse ? ' · reverse' : ''}
                      {row.pricePkn ? ` · ${formatPkn(row.pricePkn)}` : ''}
                      {' · '}
                      qty {row.quantity}
                    </span>
                    <label className="ct-pt-inline">
                      Location
                      <input
                        type="text"
                        placeholder="box1·3"
                        value={locations[key] ?? row.location ?? ''}
                        disabled={Boolean(busyKey)}
                        onChange={(event) => setLocations((prev) => ({ ...prev, [key]: event.target.value }))}
                      />
                    </label>
                  </span>
                  <span className="order-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={Boolean(busyKey)}
                      onClick={() => listPtOnly(row, index)}
                    >
                      {busyKey === key ? 'Listing…' : 'List on Pokoin'}
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={Boolean(busyKey)}
                      onClick={() => dismissPtOnly(index)}
                    >
                      Skip
                    </button>
                    <Link className="btn ghost" to="/inventory/scan">
                      Add via scan
                    </Link>
                  </span>
                </article>
              );
            })}
          </div>
        </DeskPanel>
      ) : null}

      {reconcile && !ctOnly.length && !ptOnly.length ? (
        <EmptyDesk title="Fully matched" lede="Every CardTrader product lined up with a Power Tools row.">
          <Link className="btn" to="/mypokoin">Open MyPokoin</Link>
        </EmptyDesk>
      ) : null}
    </div>
  );
}
