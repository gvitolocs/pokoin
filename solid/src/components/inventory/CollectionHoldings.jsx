import { createEffect, createMemo, createSignal, For, Show, untrack } from 'solid-js';
import {
  cancelListing,
  createListing,
  fetchAllSellerListings,
  fetchOwnedCollection,
  fetchPriceCheck,
  imageSrc,
  removeCollectionItem,
  requestNftShipping,
} from '@market/api.js';
import { collectionRowMatches, isNftHolding, partitionHoldings, splitOwnedDesk, suggestedHoldingAsk } from '@market/collection-holdings.js';
import { priceCheckItem } from '@market/inventory-price.js';
import CardArt from '../CardArt.jsx';
import { Alert, DeskPanel, EmptyDesk } from '../Desk.jsx';
import { accountProfile } from '../../stores/account.js';
import { authUid, authUser, getBearer, signedIn } from '../../stores/auth.js';
import { sellerCurrency, sellerSettings } from '../../stores/buyer.js';

const DRAG_TYPE = 'application/x-pokoin-collection';
const ADDRESS_FIELDS = ['name', 'line1', 'city', 'postalCode', 'country'];

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

function cardPicture(row) {
  return imageSrc({
    id: row?.cardId || row?.blueprintId || row?.card_id,
    imageUrl: row?.cardImageUrl || row?.imageUrl || row?.image_url || row?.heroImageUrl || '',
    heroImageUrl: row?.heroImageUrl || row?.cardImageUrl || row?.imageUrl || '',
  }, 'hero');
}

function HoldingRow(props) {
  const row = () => props.row;
  const nft = () => isNftHolding(row());
  const meta = () => holdingMeta(row());
  return (
    <article
      class="collection-tile"
      data-ownership={nft() ? 'nft' : 'physical'}
      draggable={props.draggable ? 'true' : undefined}
      onDragStart={(event) => { if (props.draggable) props.onDragCard(event, row()); }}
    >
      <CardArt class="collection-tile-art" src={cardPicture(row())} alt={cardLabel(row())} full />
      <div class="collection-tile-body">
        <strong class="thread-title">{cardLabel(row())}</strong>
        <span class="thread-meta">
          <span class="thread-badge">{nft() ? 'NFT' : 'Physical'}</span>
          {meta().length ? ` · ${meta().join(' · ')}` : ''}
        </span>
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
                onDragStart={(event) => event.preventDefault()}
              />
              <em class="collection-ask-unit">{props.currency || 'PKN'}</em>
            </span>
          </label>
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
  const meta = () => listingMeta(listing()).filter((part) => !String(part).endsWith(' PKN'));
  const price = () => Number(listing()?.pricePkn ?? listing()?.price_pkn ?? 0);
  return (
    <article class="collection-tile" data-ownership="listed" draggable="true" onDragStart={(event) => props.onDragCard(event, props.entry)}>
      <CardArt class="collection-tile-art" src={cardPicture(row())} alt={name()} full />
      <div class="collection-tile-body">
        <strong class="thread-title">{name()}</strong>
        <span class="thread-meta">
          <span class="thread-badge">Listed</span>
          {meta().length ? ` · ${meta().join(' · ')}` : ''}
        </span>
        <Show when={Number.isFinite(price()) && price() > 0}>
          <p class="collection-tile-price">{price()} {props.currency || 'PKN'}</p>
        </Show>
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

function readDrag(event) {
  const raw = event.dataTransfer.getData(DRAG_TYPE) || event.dataTransfer.getData('text/plain');
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * MyPokoin Collection tab:
 * what you own, physical + NFT. Listed copies stay owned and sit on the
 * right; drag a card across to list it or to hold it.
 */
export default function CollectionHoldings() {
  const uid = () => authUid() || accountProfile()?.uid || '';
  const [rows, setRows] = createSignal(null);
  const [listings, setListings] = createSignal([]);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [form, setForm] = createSignal({ name: '', line1: '', city: '', postalCode: '', country: '' });
  const [removingId, setRemovingId] = createSignal(null);
  const [over, setOver] = createSignal('');
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
    setRows(null);
    setError('');
    const seller = untrack(uid);
    try {
      const token = await getBearer();
      const [owned, stock] = await Promise.all([
        fetchOwnedCollection(token),
        seller ? fetchAllSellerListings(seller, token).catch(() => ({ listings: [] })) : { listings: [] },
      ]);
      setRows(Array.isArray(owned.items) ? owned.items : []);
      setListings(stock.listings || stock.items || []);
    } catch (err) {
      console.error('collection load failed', err);
      setError("Couldn't load your collection");
      setRows([]);
    }
  }

  createEffect(
    () => (signedIn() ? uid() || 'signed-in' : ''),
    (key) => {
      if (!key) {
        setRows(null);
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
    const price = Number(asks()[holding.id] || 0);
    if (!Number.isInteger(price) || price <= 0) {
      setError(`Set an ask in PKN before listing ${cardLabel(holding)}.`);
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
        const holding = (rows() || []).find((row) => row.id === drag.id);
        if (holding && !isNftHolding(holding)) await listHolding(holding);
      }
      if (side === 'held' && drag.side === 'listed') {
        const entry = desk().listed.find((row) => String(row.listing?.id || '') === drag.id);
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
    if (removingId()) return;
    setRemovingId(row.id);
    setError('');
    setMessage('');
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

  function Column(colProps) {
    return (
      <section
        class={['collection-column', { 'is-over': over() === colProps.side }]}
        data-testid={`collection-${colProps.side}`}
        onDragOver={(event) => { event.preventDefault(); setOver(colProps.side); }}
        onDragLeave={() => setOver((current) => (current === colProps.side ? '' : current))}
        onDrop={(event) => { void onDrop(colProps.side, event); }}
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
            {ownedCards()} card{ownedCards() === 1 ? '' : 's'} owned. Drag a card right to sell it, or left to hold it.
          </p>
          <div class="collection-split">
            <Column side="held">
              <DeskPanel flush title="In your collection" extra={<span class="thread-badge">{heldPhysical().length}</span>}>
                <p class="page-lede">Not for sale. Set an ask, then drag the card to Listed.</p>
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
                          draggable
                          onDragCard={dragHolding}
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
                <p class="page-lede">For sale. Drag a card left when you want to hold it.</p>
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
                      {(entry) => <ListedRow entry={entry()} currency={sellerCurrency()} onDragCard={dragListed} />}
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
