import { createEffect, createMemo, createSignal, For, Show, untrack } from 'solid-js';
import {
  cancelListing,
  createListing,
  fetchOwnedCollection,
  fetchPriceCheck,
  imageSrc,
  removeCollectionItem,
  requestNftShipping,
} from '@market/api.js';
import { collectionRowMatches, isNftHolding, partitionHoldings, splitOwnedDesk, suggestedHoldingAsk } from '@market/collection-holdings.js';
import { game } from '@market/game.js';
import { inventoryBooks } from '@market/inventory-book.js';
import { priceCheckItem } from '@market/inventory-price.js';
import ScanImage from '../ScanImage.jsx';
import { Alert, DeskPanel, EmptyDesk } from '../Desk.jsx';
import { loadOwnerBook } from '../../lib/owner-book.js';
import { createPointerDrag } from '../../lib/pointer-drag.js';
import { accountProfile } from '../../stores/account.js';
import { authUid, authUser, getBearer, signedIn } from '../../stores/auth.js';
import { sellerCurrency, sellerSettings } from '../../stores/buyer.js';
import { previewCollection } from '../../pages/mypokoin-preview-fixture.js';

const ADDRESS_FIELDS = ['name', 'line1', 'city', 'postalCode', 'country'];

// The last holdings read, in memory only: a revisit of the tab repaints them
// while they refresh instead of blanking to a skeleton.
let holdingsMemo = { uid: '', rows: null };

function canShip(row) {
  const status = String(row.physicalShippingStatus || '');
  return isNftHolding(row) && (!status || status === 'not_requested');
}

function cardLabel(row) {
  return row?.cardName || row?.name || row?.cardId || 'Card';
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

function cardPicture(row) {
  return imageSrc({
    id: row?.cardId || row?.blueprintId || row?.card_id,
    imageUrl: row?.cardImageUrl || row?.imageUrl || row?.image_url || row?.heroImageUrl || '',
    heroImageUrl: row?.heroImageUrl || row?.cardImageUrl || row?.imageUrl || '',
  }, 'hero');
}

function setLine(row) {
  return [row?.setName, row?.collectorNumber].filter(Boolean).join(' · ');
}

function FacetChips(props) {
  return (
    <span class="collection-chips">
      <For each={props.chips}>{(chip) => <span class="facet-chip">{chip}</span>}</For>
    </span>
  );
}

function HoldingRow(props) {
  const row = () => props.row;
  const nft = () => isNftHolding(row());
  const chips = () => [
    nft() ? 'NFT' : 'Physical',
    row().condition,
    row().language,
    nft() ? (row().physicalShippingStatus || 'not_requested') : null,
    Number(row().quantity) > 1 ? `×${row().quantity}` : null,
  ].filter(Boolean);
  return (
    <article
      class={['collection-tile', { 'is-draggable': Boolean(props.onPointerDown) }]}
      data-ownership={nft() ? 'nft' : 'physical'}
      draggable="false"
      onPointerDown={(event) => props.onPointerDown?.(event, row())}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
    >
      <ScanImage class="collection-tile-art" letterClass="collection-tile-art scan-letter" src={cardPicture(row())} label={cardLabel(row())} alt={cardLabel(row())} />
      <div class="collection-tile-body">
        <strong class="thread-title">{cardLabel(row())}</strong>
        <Show when={setLine(row())}><span class="thread-meta">{setLine(row())}</span></Show>
        <FacetChips chips={chips()} />
        <Show when={props.onAsk}>
          <label class="collection-ask">
            <span>Ask</span>
            <span class="collection-ask-field">
              <input
                inputmode="numeric"
                class={{ 'is-suggested': Boolean(props.suggested) }}
                value={props.ask}
                placeholder="0"
                aria-label={`Ask price for ${cardLabel(row())}`}
                onInput={(event) => {
                  const value = event.target.value.replace(/[^\d]/g, '');
                  event.target.value = value;
                  props.onAsk(row().id, value);
                }}
              />
              <em class="collection-ask-unit">{props.currency || 'PKN'}</em>
            </span>
          </label>
        </Show>
        <Show when={props.onList}>
          <button type="button" class="btn ghost collection-move" disabled={props.busy} onClick={() => props.onList(row())}>
            List →
          </button>
        </Show>
      </div>
      <Show when={props.onRemove}>
        <button
          type="button"
          class="thread-remove"
          data-testid="collection-remove"
          aria-label={`Remove ${cardLabel(row())} from collection`}
          title="Remove from collection"
          disabled={props.removing}
          onClick={() => props.onRemove(row())}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </Show>
    </article>
  );
}

function ListedRow(props) {
  const listing = () => props.entry.listing;
  const row = () => props.entry.holding || listing();
  const name = () => cardLabel(row());
  const chips = () => listingMeta(listing()).filter((part) => !String(part).endsWith(' PKN'));
  const price = () => Number(listing()?.pricePkn ?? listing()?.price_pkn ?? 0);
  return (
    <article
      class="collection-tile is-draggable"
      data-ownership="listed"
      draggable="false"
      onPointerDown={(event) => props.onPointerDown?.(event, props.entry)}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
    >
      <ScanImage class="collection-tile-art" letterClass="collection-tile-art scan-letter" src={cardPicture(row())} label={name()} alt={name()} />
      <div class="collection-tile-body">
        <strong class="thread-title">{name()}</strong>
        <Show when={setLine(row())}><span class="thread-meta">{setLine(row())}</span></Show>
        <FacetChips chips={['Listed', ...chips()]} />
        <Show when={Number.isFinite(price()) && price() > 0}>
          <p class="collection-tile-price">{price()} {props.currency || 'PKN'}</p>
        </Show>
        <button type="button" class="btn ghost collection-move" disabled={props.busy} onClick={() => props.onHold(props.entry)}>
          ← Hold
        </button>
      </div>
    </article>
  );
}

function ColumnTools(props) {
  return (
    <div class="collection-tools">
      <input type="search" value={props.query} placeholder="Search" aria-label="Search cards" onInput={(event) => props.onQuery(event.target.value)} />
      <select value={props.condition} aria-label="Condition" onChange={(event) => props.onCondition(event.target.value)}>
        <option value="">Condition</option>
        <For each={props.conditions}>{(code) => <option value={code}>{code}</option>}</For>
      </select>
      <select value={props.language} aria-label="Language" onChange={(event) => props.onLanguage(event.target.value)}>
        <option value="">Language</option>
        <For each={props.languages}>{(code) => <option value={code}>{code}</option>}</For>
      </select>
    </div>
  );
}

function facetOptions(rows) {
  const conditions = new Set();
  const languages = new Set();
  for (const row of rows) {
    const condition = String(row?.condition || '').trim().toUpperCase();
    const language = String(row?.language || '').trim().toUpperCase();
    if (condition) conditions.add(condition);
    if (language) languages.add(language);
  }
  return {
    conditions: [...conditions].sort(),
    languages: [...languages].sort(),
  };
}

/**
 * MyPokoin Collection tab:
 * what you own, physical + NFT. Listed copies stay owned and sit on the
 * right; drag a card across to list it or to hold it.
 */
export default function CollectionHoldings(props) {
  const uid = () => authUid() || accountProfile()?.uid || '';
  const firstUid = untrack(uid);
  const [rows, setRows] = createSignal(holdingsMemo.uid && holdingsMemo.uid === firstUid ? holdingsMemo.rows : null);
  // Listed copies come from the seller's MyPokoin book (stored, stamp-checked).
  const [listings, setListings] = createSignal(inventoryBooks.peek(firstUid, game().id)?.rows || []);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [form, setForm] = createSignal({ name: '', line1: '', city: '', postalCode: '', country: '' });
  const [removingId, setRemovingId] = createSignal(null);
  const [heldQuery, setHeldQuery] = createSignal('');
  const [heldCond, setHeldCond] = createSignal('');
  const [heldLang, setHeldLang] = createSignal('');
  const [listedQuery, setListedQuery] = createSignal('');
  const [listedCond, setListedCond] = createSignal('');
  const [listedLang, setListedLang] = createSignal('');
  const [asks, setAsks] = createSignal({});
  const [suggestedAsks, setSuggestedAsks] = createSignal({});
  const editedAsks = new Set();

  async function loadCollection() {
    setError('');
    const seller = untrack(uid);
    const gameId = game().id;
    try {
      const token = await getBearer();
      const [owned] = await Promise.all([
        fetchOwnedCollection(token),
        seller
          ? loadOwnerBook(seller, gameId, (next, complete = true) => { if (complete) setListings(next); }).catch(() => null)
          : null,
      ]);
      const items = Array.isArray(owned.items) ? owned.items : [];
      holdingsMemo = { uid: seller, rows: items };
      setRows(items);
    } catch (err) {
      console.error('collection load failed', err);
      setError("Couldn't load your collection");
      setRows([]);
    }
  }

  createEffect(
    () => (props.preview ? 'preview' : (signedIn() ? uid() || 'signed-in' : '')),
    (key) => {
      if (!key) {
        setRows(null);
        return;
      }
      if (key === 'preview') {
        const pack = previewCollection();
        setRows(pack.rows);
        setListings(pack.listings);
        setAsks(pack.asks);
        setError('');
        return;
      }
      loadCollection().catch(() => setRows([]));
    },
  );

  const nft = createMemo(() => partitionHoldings(rows() || []).nft);
  const desk = createMemo(() => splitOwnedDesk(rows() || [], listings()));
  const shippable = () => nft().filter(canShip);
  const heldPhysical = createMemo(() => desk().held.filter((entry) => entry.kind !== 'nft'));
  const heldNft = () => desk().held.filter((entry) => entry.kind === 'nft');
  const visibleHeld = () => heldPhysical().filter((entry) => collectionRowMatches(entry.holding, { query: heldQuery(), condition: heldCond(), language: heldLang() }));
  const visibleListed = () => desk().listed.filter((entry) => collectionRowMatches(entry.holding || entry.listing, { query: listedQuery(), condition: listedCond(), language: listedLang() }));
  const heldFacets = () => facetOptions(heldPhysical().map((entry) => entry.holding));
  const listedFacets = () => facetOptions(desk().listed.map((entry) => entry.holding || entry.listing));
  const ownedCards = () => (rows() || []).reduce((sum, row) => sum + (Number(row.quantity) > 0 ? Number(row.quantity) : 0), 0)
    + desk().listed.filter((entry) => !entry.holding).reduce((sum, entry) => {
      const qty = Number(entry.listing?.quantityAvailable ?? entry.listing?.quantity_available ?? 0);
      return sum + (qty > 0 ? qty : 0);
    }, 0);

  createEffect(
    () => (rows() ? `${ownedCards()}:${heldPhysical().length}:${desk().listed.length}` : ''),
    (key) => {
      if (!key) return;
      const [owned, held, listed] = key.split(':').map(Number);
      props.onStats?.({ owned, held, listed });
    },
  );

  function setAsk(id, value) {
    editedAsks.add(id);
    const marks = suggestedAsks();
    if (marks[id]) {
      const next = { ...marks };
      delete next[id];
      setSuggestedAsks(next);
    }
    setAsks((current) => ({ ...current, [id]: value }));
  }

  const heldKey = createMemo(() => heldPhysical().map((entry) => [
    entry.holding.id,
    entry.holding.cardId || entry.holding.blueprintId || '',
    entry.holding.condition || '',
    entry.holding.language || '',
  ].join(':')).join('|'));

  // Suggested asks from market comps for every held card the seller has not typed over.
  createEffect(
    () => (signedIn() && heldKey() ? heldKey() : ''),
    (key) => {
      if (!key) return undefined;
      const holdings = untrack(heldPhysical).map((entry) => entry.holding);
      let cancelled = false;
      (async () => {
        try {
          const items = holdings.map(priceCheckItem).filter((item) => /^\d+$/.test(item.cardId));
          if (!items.length) return;
          const token = await getBearer();
          const data = await fetchPriceCheck(items.slice(0, 100), token);
          if (cancelled) return;
          const prices = data?.prices || {};
          const marks = {};
          const next = { ...untrack(asks) };
          for (const holding of holdings) {
            if (editedAsks.has(holding.id)) continue;
            const ask = suggestedHoldingAsk(prices, holding);
            if (!ask) continue;
            next[holding.id] = ask;
            marks[holding.id] = true;
          }
          setAsks(next);
          if (Object.keys(marks).length) setSuggestedAsks((current) => ({ ...current, ...marks }));
        } catch (err) {
          console.error('collection price suggestion failed', err);
        }
      })();
      return () => {
        cancelled = true;
      };
    },
  );

  async function listHolding(holding) {
    const price = Number(asks()[holding.id] || 0);
    if (!Number.isInteger(price) || price <= 0) {
      setError(`Set an ask in PKN before listing ${cardLabel(holding)}.`);
      return;
    }
    if (props.preview) {
      const listing = {
        id: `preview-${holding.id}`,
        cardId: holding.cardId || holding.blueprintId,
        cardName: holding.cardName || holding.name,
        cardImageUrl: holding.cardImageUrl || '',
        setName: holding.setName || '',
        collectorNumber: holding.collectorNumber || '',
        condition: holding.condition || 'NM',
        language: holding.language || 'EN',
        pricePkn: price,
        quantityAvailable: Math.max(1, Number(holding.quantity) || 1),
        status: 'active',
        sourceListingId: holding.id,
      };
      setListings((current) => [...(current || []), listing]);
      setRows((current) => (current || []).map((row) => (
        row.id === holding.id ? { ...row, listingId: listing.id } : row
      )));
      setMessage(`${cardLabel(holding)} is listed at ${price} PKN.`);
      return;
    }
    const shipFrom = String(sellerSettings()?.shipFromCountry || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(shipFrom) || shipFrom === 'EU') {
      setError('Set a ship-from country in MyPokoin settings before listing.');
      return;
    }
    const token = await getBearer();
    const profile = accountProfile();
    const sellerName = profile?.username || profile?.displayName || authUser()?.displayName || 'Pokoin seller';
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
    if (props.preview) {
      setListings((current) => (current || []).map((row) => (
        String(row.id) === listingId ? { ...row, status: 'inactive' } : row
      )));
      setRows((current) => {
        const list = current || [];
        const cleared = list.map((row) => (
          String(row.listingId || '') === listingId ? { ...row, listingId: null } : row
        ));
        if (entry.holding) return cleared;
        const listing = entry.listing || {};
        return [...cleared, {
          id: `preview-held-${listingId}`,
          cardId: listing.cardId,
          cardName: listing.cardName || listing.name,
          setName: listing.setName || '',
          collectorNumber: listing.collectorNumber || '',
          condition: listing.condition || 'NM',
          language: listing.language || 'EN',
          quantity: Math.max(1, Number(listing.quantityAvailable) || 1),
        }];
      });
      const name = cardLabel(entry.holding || entry.listing);
      setMessage(entry.holding ? `${name} is back in your collection.` : `${name} is no longer listed.`);
      return;
    }
    const token = await getBearer();
    await cancelListing(listingId, token, uid());
    setListings((current) => current.map((row) => (
      String(row.id) === listingId ? { ...row, status: 'inactive' } : row
    )));
    setRows((current) => (current || []).map((row) => (
      String(row.listingId || '') === listingId ? { ...row, listingId: null } : row
    )));
    const name = cardLabel(entry.holding || entry.listing);
    setMessage(entry.holding ? `${name} is back in your collection.` : `${name} is no longer listed.`);
  }

  async function runMove(work) {
    setError('');
    setMessage('');
    setBusy(true);
    try {
      await work();
    } catch (err) {
      console.error('collection move failed', err);
      setError(err?.message || "Couldn't move that card. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const pointer = createPointerDrag({
    onMove(action) {
      if (action.from === 'held' && action.to === 'listed') {
        const holding = (untrack(rows) || []).find((row) => row.id === action.payload?.id);
        if (holding && !isNftHolding(holding)) void runMove(() => listHolding(holding));
      }
      if (action.from === 'listed' && action.to === 'held') {
        const entry = untrack(desk).listed.find((row) => String(row.listing?.id || '') === action.payload?.id);
        if (entry) void runMove(() => holdListing(entry));
      }
    },
  });

  function dragPayload(row) {
    return { id: row?.id, image: cardPicture(row), label: cardLabel(row) };
  }

  async function removeItem(row) {
    if (removingId()) return;
    setRemovingId(row.id);
    setError('');
    setMessage('');
    if (props.preview) {
      setRows((current) => (current || []).filter((item) => item.id !== row.id));
      setMessage(`Removed ${cardLabel(row)} from your collection.`);
      setRemovingId(null);
      return;
    }
    try {
      const token = await getBearer();
      const result = await removeCollectionItem({ itemId: row.id }, token);
      setRows((current) => (current || [])
        .map((item) => (item.id === row.id ? { ...item, quantity: result.after } : item))
        .filter((item) => !(item.id === row.id && result.deleted)));
      if (result.deleted) setMessage(`Removed ${cardLabel(row)} from your collection.`);
    } catch (err) {
      console.error('collection remove failed', err);
      setError("Couldn't remove the card. Try again.");
    } finally {
      setRemovingId(null);
    }
  }

  async function requestAll(event) {
    event.preventDefault();
    const list = shippable();
    if (!list.length) {
      setError('No NFT is eligible for a shipping request.');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    if (props.preview) {
      setMessage(`Requested ${list.length} shipment${list.length === 1 ? '' : 's'}.`);
      setBusy(false);
      return;
    }
    try {
      const token = await getBearer();
      const data = await requestNftShipping({
        collectionItemIds: list.map((row) => row.id),
        shippingAddress: form(),
      }, token);
      setMessage(data.message || `Requested ${data.requests?.length || list.length} shipment${list.length === 1 ? '' : 's'}.`);
      await loadCollection();
    } catch (err) {
      console.error('NFT shipping request failed', err);
      setError("Couldn't request shipping. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const empty = () => rows() && heldPhysical().length === 0 && heldNft().length === 0 && desk().listed.length === 0 && !error();
  const loading = () => rows() == null && !error();

  const columnHot = (side) => pointer.view().phase === 'dragging' && pointer.view().over === side;

  function Column(colProps) {
    return (
      <section
        class={['collection-column', { 'is-over': columnHot(colProps.side) }]}
        data-testid={`collection-${colProps.side}`}
        data-drop-zone={colProps.side}
        ref={(element) => pointer.setZone(colProps.side, element)}
      >
        {colProps.children}
      </section>
    );
  }

  return (
    <div class="collection-holdings" data-testid="collection-desk">
      <Show when={error()}>
        <div class="desk-panel" data-testid="collection-error">
          <Alert>{error()}</Alert>
          <button type="button" class="btn ghost" onClick={() => { void loadCollection(); }} data-testid="collection-retry">Retry</button>
        </div>
      </Show>
      <Show when={message()}><p class="desk-ok">{message()}</p></Show>
      <Show when={loading()}>
        <DeskPanel title="Your collection"><div class="skeleton-line" /></DeskPanel>
      </Show>
      <Show when={empty()}>
        <EmptyDesk title="No cards in your collection yet" lede="Scan cards to add them, or checkout an NFT listing.">
          <a class="btn" href="/scan">Scan cards</a>
          <a class="btn ghost" href="/product/nft">Search NFT catalog</a>
        </EmptyDesk>
      </Show>
      <Show when={rows() && !empty()}>
        <div class="collection-desk">
          <p class="page-lede">
            {ownedCards()} card{ownedCards() === 1 ? '' : 's'} owned. Drag a card across, or use List and Hold.
          </p>
          <div class="collection-split">
            <Column side="held">
              <DeskPanel flush title="In your collection" extra={<span class="thread-badge">{heldPhysical().length}</span>}>
                <p class="page-lede">Not for sale. Set an ask, then press List or drag the card to Listed.</p>
                <ColumnTools
                  query={heldQuery()}
                  onQuery={setHeldQuery}
                  condition={heldCond()}
                  onCondition={setHeldCond}
                  language={heldLang()}
                  onLanguage={setHeldLang}
                  conditions={heldFacets().conditions}
                  languages={heldFacets().languages}
                />
                <Show
                  when={visibleHeld().length}
                  fallback={<p class="page-lede">{heldPhysical().length ? 'No cards match this search.' : 'Nothing held back. Drop a listed card here to stop selling it.'}</p>}
                >
                  <div class="collection-tile-grid" data-testid="collection-physical">
                    <For each={visibleHeld()} keyed={(entry) => entry.holding.id}>
                      {(entry) => (
                        <HoldingRow
                          row={entry().holding}
                          ask={asks()[entry().holding.id] || ''}
                          currency={sellerCurrency()}
                          suggested={Boolean(suggestedAsks()[entry().holding.id])}
                          onAsk={setAsk}
                          busy={busy()}
                          onList={(holding) => { void runMove(() => listHolding(holding)); }}
                          onPointerDown={(event, card) => pointer.onPointerDown(event, { ...dragPayload(card), id: card.id }, 'held')}
                          onPointerMove={pointer.onPointerMove}
                          onPointerUp={pointer.onPointerUp}
                          onPointerCancel={pointer.onPointerCancel}
                          onRemove={removeItem}
                          removing={removingId() === entry().holding.id}
                        />
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={heldNft().length}>
                  <div class="collection-tile-grid" data-testid="collection-nft">
                    <p class="page-lede">NFT · {heldNft().length} holding{heldNft().length === 1 ? '' : 's'}</p>
                    <For each={heldNft()}>{(entry) => <HoldingRow row={entry.holding} />}</For>
                  </div>
                </Show>
              </DeskPanel>
            </Column>
            <Column side="listed">
              <DeskPanel flush title="Listed" extra={<span class="thread-badge">{desk().listed.length}</span>}>
                <p class="page-lede">For sale. Press Hold or drag a card left when you want to keep it.</p>
                <ColumnTools
                  query={listedQuery()}
                  onQuery={setListedQuery}
                  condition={listedCond()}
                  onCondition={setListedCond}
                  language={listedLang()}
                  onLanguage={setListedLang}
                  conditions={listedFacets().conditions}
                  languages={listedFacets().languages}
                />
                <Show
                  when={visibleListed().length}
                  fallback={<p class="page-lede">{desk().listed.length ? 'No cards match this search.' : 'No cards listed. Drop one here to sell it.'}</p>}
                >
                  <div class="collection-tile-grid">
                    <For each={visibleListed()} keyed={(entry) => String(entry.listing.id)}>
                      {(entry) => (
                        <ListedRow
                          entry={entry()}
                          currency={sellerCurrency()}
                          busy={busy()}
                          onHold={(card) => { void runMove(() => holdListing(card)); }}
                          onPointerDown={(event, card) => pointer.onPointerDown(
                            event,
                            { ...dragPayload(card.holding || card.listing), id: String(card.listing?.id || '') },
                            'listed',
                          )}
                          onPointerMove={pointer.onPointerMove}
                          onPointerUp={pointer.onPointerUp}
                          onPointerCancel={pointer.onPointerCancel}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </DeskPanel>
            </Column>
          </div>
          <Show
            when={shippable().length}
            fallback={(
              <Show when={nft().length}>
                <DeskPanel title="NFT shipping">
                  <p class="page-lede">No NFT holding is eligible for a shipping request right now.</p>
                </DeskPanel>
              </Show>
            )}
          >
            <form onSubmit={requestAll}>
              <DeskPanel
                title="Request physical shipping (NFT)"
                actions={<button class="btn" type="submit" disabled={busy()}>{busy() ? 'Sending…' : `Request ${shippable().length}`}</button>}
              >
                <p class="page-lede">NFT holdings only. Does not charge PKN. Stays pending ops review.</p>
                <For each={ADDRESS_FIELDS}>
                  {(key) => (
                    <label class="sell-field">
                      {key}
                      <input required value={form()[key]} onInput={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} />
                    </label>
                  )}
                </For>
              </DeskPanel>
            </form>
          </Show>
        </div>
      </Show>
    </div>
  );
}
