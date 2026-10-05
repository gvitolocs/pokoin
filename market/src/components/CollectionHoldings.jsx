import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  cancelListing,
  createListing,
  fetchOwnedCollection,
  fetchPriceCheck,
  fetchSellerListings,
  removeCollectionItem,
  requestNftShipping,
} from '../api.js';
import { useAuth } from '../auth.jsx';
import { isNftHolding, partitionHoldings, splitOwnedDesk, suggestedHoldingAsk } from '../collection-holdings.js';
import { useSellerCurrency } from '../use-seller-currency.js';
import { Alert, DeskPanel, EmptyDesk } from './Desk.jsx';

const DRAG_TYPE = 'application/x-pokoin-collection';

function canShip(row) {
  const status = String(row.physicalShippingStatus || '');
  return isNftHolding(row) && (!status || status === 'not_requested');
}

function cardLabel(row) {
  return row?.cardName || row?.name || row?.cardId || 'Card';
}

function holdingMeta(row) {
  return [
    row.setName,
    row.collectorNumber,
    row.condition,
    row.language,
    isNftHolding(row) ? (row.physicalShippingStatus || 'not_requested') : null,
    Number(row.quantity) > 1 ? `×${row.quantity}` : null,
  ].filter(Boolean);
}

function listingMeta(listing) {
  const price = Number(listing?.pricePkn ?? listing?.price_pkn ?? 0);
  return [
    Number.isFinite(price) && price > 0 ? `${price} PKN` : null,
    listing?.condition,
    listing?.language,
    Number(listing?.quantityAvailable ?? listing?.quantity_available) > 1
      ? `×${listing.quantityAvailable ?? listing.quantity_available}`
      : null,
    String(listing?.status || '').toLowerCase() === 'paused' ? 'Paused' : null,
  ].filter(Boolean);
}

function HoldingRow({ row, onRemove, removing, ask, suggested = false, onAsk, draggable = false, onDragCard }) {
  const nft = isNftHolding(row);
  const meta = holdingMeta(row);
  return (
    <article
      className="thread collection-card"
      data-ownership={nft ? 'nft' : 'physical'}
      draggable={draggable}
      onDragStart={draggable ? (event) => onDragCard(event, row) : undefined}
    >
      <span className="thread-main">
        <strong className="thread-title">{cardLabel(row)}</strong>
        <span className="thread-meta">
          <span className="thread-badge">{nft ? 'NFT' : 'Physical'}</span>
          {meta.length ? ` · ${meta.join(' · ')}` : ''}
        </span>
      </span>
      {onAsk ? (
        <label className="collection-ask">
          <span>Ask</span>
          <input
            inputMode="numeric"
            className={suggested ? 'is-suggested' : ''}
            value={ask}
            placeholder="PKN"
            aria-label={`Ask price for ${cardLabel(row)}`}
            onChange={(event) => onAsk(row.id, event.target.value.replace(/[^\d]/g, ''))}
            onDragStart={(event) => event.preventDefault()}
          />
        </label>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          className="thread-remove"
          data-testid="collection-remove"
          aria-label={`Remove ${cardLabel(row)} from collection`}
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

function ListedRow({ entry, onDragCard }) {
  const listing = entry.listing;
  const name = cardLabel(entry.holding || listing);
  const meta = listingMeta(listing);
  return (
    <article
      className="thread collection-card"
      data-ownership="listed"
      draggable
      onDragStart={(event) => onDragCard(event, entry)}
    >
      <span className="thread-main">
        <strong className="thread-title">{name}</strong>
        <span className="thread-meta">
          <span className="thread-badge">Listed</span>
          {meta.length ? ` · ${meta.join(' · ')}` : ''}
        </span>
      </span>
    </article>
  );
}

function readDrag(event) {
  const raw = event.dataTransfer.getData(DRAG_TYPE) || event.dataTransfer.getData('text/plain');
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * MyPokoin Collection tab (/mypokoin/collection): what you own, physical +
 * NFT. Listed copies stay owned and sit on the right. Drag a card across
 * to list it or to hold it. The old /collection page redirects here.
 */
export default function CollectionHoldings() {
  const { signedIn, user, profile, getBearer } = useAuth();
  const { settings } = useSellerCurrency();
  const [rows, setRows] = useState(null);
  const [listings, setListings] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ name: '', line1: '', city: '', postalCode: '', country: '' });
  const [removingId, setRemovingId] = useState(null);
  const [over, setOver] = useState('');
  const [asks, setAsks] = useState({});
  const [suggestedAsks, setSuggestedAsks] = useState({});
  const asksRef = useRef(asks);
  const editedAsks = useRef(new Set());
  asksRef.current = asks;

  const loadCollection = useCallback(async () => {
    setRows(null);
    setError('');
    const uid = user?.uid || profile?.uid;
    try {
      const token = await getBearer();
      const [owned, stock] = await Promise.all([
        fetchOwnedCollection(token),
        uid ? fetchSellerListings(uid, token, { limit: 1000 }).catch(() => ({ listings: [] })) : { listings: [] },
      ]);
      setRows(Array.isArray(owned.items) ? owned.items : []);
      setListings(stock.listings || stock.items || []);
    } catch (err) {
      console.error('collection load failed', err);
      setError("Couldn't load your collection");
      setRows([]);
    }
  }, [getBearer, user?.uid, profile?.uid]);

  useEffect(() => {
    if (!signedIn) {
      setRows(null);
      return undefined;
    }
    let cancelled = false;
    loadCollection().catch(() => {
      if (!cancelled) setRows([]);
    });
    return () => {
      cancelled = true;
    };
  }, [signedIn, user?.uid, profile?.uid, loadCollection]);

  const { nft } = useMemo(() => partitionHoldings(rows || []), [rows]);
  const desk = useMemo(() => splitOwnedDesk(rows || [], listings), [rows, listings]);
  const shippable = nft.filter(canShip);
  const heldPhysical = desk.held.filter((entry) => entry.kind !== 'nft');
  const heldNft = desk.held.filter((entry) => entry.kind === 'nft');
  const ownedCards = (rows || []).reduce((sum, row) => sum + (Number(row.quantity) > 0 ? Number(row.quantity) : 0), 0)
    + desk.listed.filter((entry) => !entry.holding).reduce((sum, entry) => {
      const qty = Number(entry.listing?.quantityAvailable ?? entry.listing?.quantity_available ?? 0);
      return sum + (qty > 0 ? qty : 0);
    }, 0);

  function setAsk(id, value) {
    editedAsks.current.add(id);
    setSuggestedAsks((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setAsks((current) => ({ ...current, [id]: value }));
  }

  const heldKey = heldPhysical.map((entry) => [
    entry.holding.id,
    entry.holding.cardId || entry.holding.blueprintId || '',
    entry.holding.condition || '',
    entry.holding.language || '',
  ].join(':')).join('|');

  useEffect(() => {
    if (!signedIn || !heldKey) return undefined;
    const holdings = heldPhysical.map((entry) => entry.holding);
    let cancelled = false;
    (async () => {
      try {
        const items = holdings.map((holding) => ({
          cardId: String(holding.cardId || holding.blueprintId || ''),
          condition: String(holding.condition || 'NM').toUpperCase(),
          language: String(holding.language || '').toUpperCase(),
        })).filter((item) => /^\d+$/.test(item.cardId));
        if (!items.length) return;
        const token = await getBearer();
        const data = await fetchPriceCheck(items.slice(0, 100), token);
        if (cancelled) return;
        const prices = data?.prices || {};
        const marks = {};
        setAsks((current) => {
          const next = { ...current };
          for (const holding of holdings) {
            if (editedAsks.current.has(holding.id)) continue;
            const ask = suggestedHoldingAsk(prices, holding);
            if (!ask) continue;
            next[holding.id] = ask;
            marks[holding.id] = true;
          }
          return next;
        });
        if (Object.keys(marks).length) {
          setSuggestedAsks((current) => ({ ...current, ...marks }));
        }
      } catch (err) {
        console.error('collection price suggestion failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // heldKey is the holdings snapshot; heldPhysical is read from that render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, heldKey, getBearer]);

  function dragHolding(event, row) {
    const payload = JSON.stringify({ side: 'held', id: row.id });
    event.dataTransfer.setData(DRAG_TYPE, payload);
    event.dataTransfer.setData('text/plain', payload);
    event.dataTransfer.effectAllowed = 'move';
  }

  function dragListed(event, entry) {
    const payload = JSON.stringify({ side: 'listed', id: String(entry.listing?.id || '') });
    event.dataTransfer.setData(DRAG_TYPE, payload);
    event.dataTransfer.setData('text/plain', payload);
    event.dataTransfer.effectAllowed = 'move';
  }

  async function listHolding(holding) {
    const price = Number(asksRef.current[holding.id] || 0);
    if (!Number.isInteger(price) || price <= 0) {
      setError(`Set an ask in PKN before listing ${cardLabel(holding)}.`);
      return;
    }
    const shipFrom = String(settings?.shipFromCountry || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(shipFrom) || shipFrom === 'EU') {
      setError('Set a ship-from country in MyPokoin settings before listing.');
      return;
    }
    const token = await getBearer();
    const sellerName = profile?.username || profile?.displayName || user?.displayName || 'Pokoin seller';
    const saved = await createListing({
      cardId: holding.cardId || holding.blueprintId,
      sellerName,
      sellerCountry: shipFrom,
      shipFromCountry: shipFrom,
      condition: holding.condition || 'NM',
      language: holding.language || 'EN',
      pricePkn: price,
      quantityAvailable: Math.max(1, Number(holding.quantity) || 1),
      reverse: holding.reverse === true,
      firstEdition: holding.firstEdition === true,
      foilState: holding.reverse ? 'reverse' : (holding.holo ? 'holo' : 'standard'),
      graded: holding.graded === true,
      gradingCompany: holding.gradingCompany,
      grade: holding.grade,
      certificationId: holding.certificationId,
      source: 'pokoin_collection',
      sourceListingId: holding.id,
      cardName: holding.cardName || holding.name,
      cardImageUrl: holding.cardImageUrl || '',
      setName: holding.setName || '',
      collectorNumber: holding.collectorNumber || '',
    }, token);
    const listing = saved?.listing || saved;
    if (listing?.id) {
      setListings((current) => [...current, { ...listing, sourceListingId: holding.id }]);
      setRows((current) => (current || []).map((row) => (
        row.id === holding.id ? { ...row, listingId: listing.id } : row
      )));
    }
    setMessage(`${cardLabel(holding)} is listed at ${price} PKN.`);
  }

  async function holdListing(entry) {
    const listingId = String(entry.listing?.id || '');
    if (!listingId) return;
    const token = await getBearer();
    const uid = user?.uid || profile?.uid;
    await cancelListing(listingId, token, uid);
    setListings((current) => current.map((row) => (
      String(row.id) === listingId ? { ...row, status: 'inactive' } : row
    )));
    setRows((current) => (current || []).map((row) => (
      String(row.listingId || '') === listingId ? { ...row, listingId: null } : row
    )));
    const name = cardLabel(entry.holding || entry.listing);
    setMessage(entry.holding ? `${name} is back in your collection.` : `${name} is no longer listed.`);
  }

  async function onDrop(side, event) {
    event.preventDefault();
    setOver('');
    const drag = readDrag(event);
    if (!drag) return;
    setError('');
    setMessage('');
    setBusy(true);
    try {
      if (side === 'listed' && drag.side === 'held') {
        const holding = (rows || []).find((row) => row.id === drag.id);
        if (holding && !isNftHolding(holding)) await listHolding(holding);
      }
      if (side === 'held' && drag.side === 'listed') {
        const entry = desk.listed.find((row) => String(row.listing?.id || '') === drag.id);
        if (entry) await holdListing(entry);
      }
    } catch (err) {
      console.error('collection move failed', err);
      setError(err?.message || "Couldn't move that card. Try again.");
    } finally {
      setBusy(false);
    }
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
        .map((item) => (item.id === row.id ? { ...item, quantity: result.after } : item))
        .filter((item) => !(item.id === row.id && result.deleted)));
      if (result.deleted) {
        setMessage(`Removed ${cardLabel(row)} from your collection.`);
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

  const empty = rows && heldPhysical.length === 0 && heldNft.length === 0 && desk.listed.length === 0 && !error;
  const loading = rows == null && !error;

  return (
    <div className="collection-holdings" data-testid="collection-desk">
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
      {rows && !empty ? (
        <div className="collection-desk">
          <p className="page-lede">
            {ownedCards} card{ownedCards === 1 ? '' : 's'} owned. Drag a card right to sell it, or left to hold it.
          </p>
          <div className="collection-split">
            <section
              className={`collection-column${over === 'held' ? ' is-over' : ''}`}
              data-testid="collection-held"
              onDragOver={(event) => { event.preventDefault(); setOver('held'); }}
              onDragLeave={() => setOver((current) => (current === 'held' ? '' : current))}
              onDrop={(event) => { void onDrop('held', event); }}
            >
              <DeskPanel flush title="In your collection" extra={<span className="thread-badge">{heldPhysical.length}</span>}>
                <p className="page-lede">Not for sale. Set an ask, then drag the card to Listed.</p>
                {heldPhysical.length ? (
                  <div className="thread-list" data-testid="collection-physical">
                    {heldPhysical.map((entry) => (
                      <HoldingRow
                        key={entry.holding.id}
                        row={entry.holding}
                        ask={asks[entry.holding.id] || ''}
                        suggested={Boolean(suggestedAsks[entry.holding.id])}
                        onAsk={setAsk}
                        draggable
                        onDragCard={dragHolding}
                        onRemove={removeItem}
                        removing={removingId === entry.holding.id}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="page-lede">Nothing held back. Drop a listed card here to stop selling it.</p>
                )}
                {heldNft.length ? (
                  <div className="thread-list" data-testid="collection-nft">
                    <p className="page-lede">NFT · {heldNft.length} holding{heldNft.length === 1 ? '' : 's'}</p>
                    {heldNft.map((entry) => <HoldingRow key={entry.holding.id} row={entry.holding} />)}
                  </div>
                ) : null}
              </DeskPanel>
            </section>
            <section
              className={`collection-column${over === 'listed' ? ' is-over' : ''}`}
              data-testid="collection-listed"
              onDragOver={(event) => { event.preventDefault(); setOver('listed'); }}
              onDragLeave={() => setOver((current) => (current === 'listed' ? '' : current))}
              onDrop={(event) => { void onDrop('listed', event); }}
            >
              <DeskPanel flush title="Listed" extra={<span className="thread-badge">{desk.listed.length}</span>}>
                <p className="page-lede">For sale. Drag a card left when you want to hold it.</p>
                {desk.listed.length ? (
                  <div className="thread-list">
                    {desk.listed.map((entry) => (
                      <ListedRow
                        key={String(entry.listing.id)}
                        entry={entry}
                        onDragCard={dragListed}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="page-lede">No cards listed. Drop one here to sell it.</p>
                )}
              </DeskPanel>
            </section>
          </div>
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
