import { createEffect, createSignal, For, Show, untrack } from 'solid-js';
import { useLocation } from '@solidjs/router';
import {
  cancelListing,
  createListing,
  fetchCardTraderSyncStatus,
  fetchSearch,
  fetchSellerListings,
  fetchSellerSettings,
  formatPkn,
  updateListing,
} from '@market/api.js';
import { GAMES } from '@market/game.js';
import { Alert, DeskPanel, EmptyDesk } from '../components/Desk.jsx';
import RowThumb from '../components/inventory/RowThumb.jsx';
import StockNav from '../components/StockNav.jsx';
import { accountProfile } from '../stores/account.js';
import { authUser, getBearer, signedIn } from '../stores/auth.js';
import { authSession } from '../stores/session.js';
import { RequireSignIn } from './tools/auth-gate.jsx';
import { usePageTitle } from './tools/board.jsx';

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

function SyncReviewDesk() {
  const uid = () => authUser()?.uid || accountProfile()?.uid || authSession()?.uid || '';
  const sellerName = () => {
    const profile = accountProfile();
    return profile?.username || profile?.displayName || authUser()?.displayName || 'Pokoin seller';
  };
  const [reconcile, setReconcile] = createSignal(null);
  const [listings, setListings] = createSignal([]);
  const [shipFromCountry, setShipFromCountry] = createSignal('');
  const [error, setError] = createSignal('');
  const [message, setMessage] = createSignal('');
  const [busyKey, setBusyKey] = createSignal('');
  const [locations, setLocations] = createSignal({});
  const [dismissedPt, setDismissedPt] = createSignal(new Set());

  createEffect(
    () => (signedIn() ? uid() : ''),
    (id) => {
      if (!id) return undefined;
      let cancelled = false;
      getBearer()
        .then(async (token) => {
          const [syncData, listData, settings] = await Promise.all([
            fetchCardTraderSyncStatus(token),
            fetchSellerListings(id, token, { limit: 1000 }),
            fetchSellerSettings(token).catch(() => ({})),
          ]);
          if (cancelled) return;
          const summary = syncData?.sync?.summary || syncData?.summary || {};
          setReconcile(() => summary.powerToolsReconcile || null);
          setListings(listData?.listings || listData?.items || []);
          setShipFromCountry(String(settings?.shipFromCountry || '').toUpperCase());
        })
        .catch((err) => {
          if (!cancelled) setError(err.message || 'Could not load sync review.');
        });
      return () => { cancelled = true; };
    },
  );

  const ctOnly = () => reconcile()?.ctOnly || [];
  // Keep the original index: dismissals and row keys are per ptOnly position.
  const ptOnly = () => (reconcile()?.ptOnly || [])
    .map((row, index) => ({ row, index }))
    .filter(({ index }) => !dismissedPt().has(index));

  function listingForCtProduct(productId) {
    const source = ctSourceId(productId);
    return listings().find((row) => String(row.sourceListingId || row.source_listing_id || '') === source) || null;
  }

  const setLocation = (key, value) => setLocations((prev) => ({ ...prev, [key]: value }));

  async function saveCtLocation(row) {
    const key = `ct:${row.ctProductId}`;
    const locationValue = String(locations()[key] || '').trim();
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
      await cancelListing(listing.id, token, uid());
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
    const country = shipFromCountry();
    if (!country) {
      setError('Set ship-from country on Profile before listing Power Tools-only cards.');
      return;
    }
    const locationValue = String(locations()[key] ?? row.location ?? '').trim();
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
        sellerName: sellerName(),
        sellerCountry: country,
        shipFromCountry: country,
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
    <div class="page desk mypokoin">
      <StockNav
        title="CardTrader ↔ Power Tools"
        lede="Cards only on CardTrader or only in Power Tools."
      >
        <a class="btn ghost" href="/mypokoin">MyPokoin</a>
        <a class="btn ghost" href="/profile">Profile</a>
      </StockNav>
      <Alert>{error()}</Alert>
      <Show when={message()}><p class="ct-connect-ok">{message()}</p></Show>

      <Show
        when={reconcile()}
        fallback={(
          <DeskPanel title="Review">
            <p class="page-lede muted">
              No Power Tools mismatch from the last sync. Use Import locations under CardTrader in Profile with your Power Tools CSVs first.
            </p>
          </DeskPanel>
        )}
      >
        <DeskPanel title="Summary">
          <p class="mypokoin-help">Cards that exist on only one side. Save a location or list the Power Tools row.</p>
          <p class="page-lede">
            Matched {Number(reconcile().matched || 0)}
            {' · '}
            locations applied {Number(reconcile().locationsApplied || 0)}
            {' · '}
            CardTrader-only {ctOnly().length}
            {' · '}
            Power Tools-only {ptOnly().length}
          </p>
        </DeskPanel>
      </Show>

      <Show when={ctOnly().length}>
        <DeskPanel flush title={`On CardTrader, not in Power Tools (${ctOnly().length})`}>
          <div class="thread-list">
            <For each={ctOnly()}>
              {(row) => {
                const key = `ct:${row.ctProductId}`;
                const listing = () => listingForCtProduct(row.ctProductId);
                return (
                  <article class="thread order-row">
                    <RowThumb row={{ cardId: row.cardId, cardName: row.name, cardImageUrl: row.imageUrl || '' }} />
                    <span class="thread-main">
                      <strong class="thread-title">{row.name || row.ctProductId}</strong>
                      <span class="thread-meta">
                        {gameName(row.game)}
                        {' · '}
                        {row.condition} {row.language}
                        {row.reverse ? ' · reverse' : ''}
                        {' · '}
                        qty {row.quantity}
                        {row.pricePkn ? ` · ${formatPkn(row.pricePkn)}` : ''}
                        {listing()?.location ? ` · now ${listing().location}` : ''}
                      </span>
                      <label class="ct-pt-inline">
                        Location
                        <input
                          type="text"
                          placeholder="box1·3"
                          value={locations()[key] ?? listing()?.location ?? ''}
                          disabled={Boolean(busyKey())}
                          onInput={(event) => setLocation(key, event.currentTarget.value)}
                        />
                      </label>
                    </span>
                    <span class="order-actions">
                      <button type="button" class="btn" disabled={Boolean(busyKey())} onClick={() => saveCtLocation(row)}>
                        {busyKey() === key ? 'Saving…' : 'Save location'}
                      </button>
                      <button
                        type="button"
                        class="btn ghost"
                        disabled={Boolean(busyKey()) || !listing()?.id}
                        onClick={() => removeCtListing(row)}
                      >
                        {busyKey() === `cancel:${row.ctProductId}` ? 'Removing…' : 'Cancel listing'}
                      </button>
                      <Show when={row.cardId}>
                        <a class="btn ghost" href={`/marketplace/en/cards/${row.cardId}`}>Open card</a>
                      </Show>
                    </span>
                  </article>
                );
              }}
            </For>
          </div>
        </DeskPanel>
      </Show>

      <Show when={ptOnly().length}>
        <DeskPanel flush title={`In Power Tools, not on CardTrader (${ptOnly().length})`}>
          <div class="thread-list">
            <For each={ptOnly()} keyed={(entry) => entry.index}>
              {(entry) => {
                // Keyed by ptOnly position: the row behind a key never changes.
                const { row, index } = untrack(entry);
                const key = ptRowKey(row, index);
                return (
                  <article class="thread order-row">
                    <RowThumb row={{ cardId: row.cardId, cardName: row.name, cardImageUrl: row.imageUrl || '' }} />
                    <span class="thread-main">
                      <strong class="thread-title">{row.name || 'Card'}</strong>
                      <span class="thread-meta">
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
                      <label class="ct-pt-inline">
                        Location
                        <input
                          type="text"
                          placeholder="box1·3"
                          value={locations()[key] ?? row.location ?? ''}
                          disabled={Boolean(busyKey())}
                          onInput={(event) => setLocation(key, event.currentTarget.value)}
                        />
                      </label>
                    </span>
                    <span class="order-actions">
                      <button type="button" class="btn" disabled={Boolean(busyKey())} onClick={() => listPtOnly(row, index)}>
                        {busyKey() === key ? 'Listing…' : 'List on Pokoin'}
                      </button>
                      <button type="button" class="btn ghost" disabled={Boolean(busyKey())} onClick={() => dismissPtOnly(index)}>
                        Skip
                      </button>
                      <a class="btn ghost" href="/inventory/scan">Add via scan</a>
                    </span>
                  </article>
                );
              }}
            </For>
          </div>
        </DeskPanel>
      </Show>

      <Show when={reconcile() && !ctOnly().length && !ptOnly().length}>
        <EmptyDesk title="Fully matched" lede="Every CardTrader product lined up with a Power Tools row.">
          <a class="btn" href="/mypokoin">Open MyPokoin</a>
        </EmptyDesk>
      </Show>
    </div>
  );
}

/** CardTrader ↔ Power Tools reconcile review. */
export default function SyncReview() {
  const location = useLocation();
  usePageTitle('CardTrader ↔ Power Tools · Pokoin');
  return (
    <RequireSignIn from={location.pathname || '/inventory/sync-review'}>
      <SyncReviewDesk />
    </RequireSignIn>
  );
}
