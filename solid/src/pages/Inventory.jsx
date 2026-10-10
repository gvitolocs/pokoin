import { createEffect, createMemo, createSignal, For, Match, Show, Switch, untrack } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { exportStockCsv, fetchPricingStrategies, fetchSellerListings } from '@market/api.js';
import { inventoryRowsForLocation, liveInventoryListings } from '@market/inventory-listings.js';
import { formatSellerPrice } from '@market/seller-currency.js';
import '@market/export-preview.css';
import { Alert, DeskPanel, EmptyDesk, PageHead } from '../components/Desk.jsx';
import CollectionHoldings from '../components/inventory/CollectionHoldings.jsx';
import InventoryBoard from '../components/inventory/InventoryBoard.jsx';
import LocationBoard from '../components/inventory/LocationBoard.jsx';
import PricingStrategies, { PricerDefaults } from '../components/inventory/PricingStrategies.jsx';
import SignedIn from '../components/SignedIn.jsx';
import StockNav from '../components/StockNav.jsx';
import { accountProfile } from '../stores/account.js';
import { authUid, getBearer, signedIn } from '../stores/auth.js';
import { sellerCurrency } from '../stores/buyer.js';

const FORMATS = [
  { id: 'powertools', label: 'Power Tools' },
  { id: 'cardmarket', label: 'Cardmarket' },
  { id: 'cardtrader', label: 'CardTrader' },
  { id: 'tcgplayer', label: 'TCGPlayer' },
];

// Paint the board off the first raw page, then top up the rest in the
// background — one round trip to first row instead of the full inventory.
const INVENTORY_FIRST_PAGE = 200;
const INVENTORY_PAGE_LIMIT = 1000;
// A first page still missing after this long is asked for again; whichever
// answer lands first fills the board.
const INVENTORY_RETRY_MS = 12000;

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** First rows of an export file, including quoted commas and line breaks. */
function parseCsvPreview(text, limit = 8) {
  const rows = [];
  let row = [];
  let cell = '';
  let quotes = false;
  const src = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quotes = false;
      } else cell += ch;
    } else if (ch === '"') quotes = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      if (rows.length > limit) break;
    } else cell += ch;
  }
  if ((cell || row.length) && rows.length <= limit) {
    row.push(cell);
    if (row.some((value) => value !== '')) rows.push(row);
  }
  const [headers, ...body] = rows;
  return { headers: headers || [], rows: body.slice(0, limit) };
}

/** The tab and storage box the path names (React useMatch on each route). */
function tabOf(pathname) {
  const path = String(pathname || '').replace(/\/+$/, '');
  const boxMatch = /^\/mypokoin\/location\/([^/]+)/.exec(path);
  let locationName = '';
  if (boxMatch) {
    try { locationName = decodeURIComponent(boxMatch[1]); } catch (_) { locationName = boxMatch[1]; }
    // The auth bounce can double-encode the · separator — decode once more.
    if (locationName.includes('%')) {
      try { locationName = decodeURIComponent(locationName); } catch (_) { /* keep */ }
    }
  }
  return {
    importTab: path === '/mypokoin/import',
    settingsTab: path === '/mypokoin/settings',
    collectionTab: path === '/mypokoin/collection',
    locationName,
  };
}

function InventoryDesk() {
  const location = useLocation();
  const tab = createMemo(() => tabOf(location.pathname), {
    equals: (a, b) => a.importTab === b.importTab && a.settingsTab === b.settingsTab
      && a.collectionTab === b.collectionTab && a.locationName === b.locationName,
  });
  // PKN opt-out sellers read their prices in local currency.
  const formatPrice = (pkn) => formatSellerPrice(pkn, sellerCurrency());
  const [rows, setRows] = createSignal(null);
  const [error, setError] = createSignal('');
  const [previewFormat, setPreviewFormat] = createSignal('powertools');
  const [preview, setPreview] = createSignal(null);
  const [previewBlob, setPreviewBlob] = createSignal(null);
  const [busy, setBusy] = createSignal('');
  const [pricerDefaults, setPricerDefaults] = createSignal(null);
  // Bumped by reload() so a stale background top-up stops writing rows.
  let inventorySeq = 0;

  async function topUpInventory(uid, token, gen) {
    let offset = INVENTORY_FIRST_PAGE;
    for (;;) {
      let data;
      try {
        data = await fetchSellerListings(uid, token, { limit: INVENTORY_PAGE_LIMIT, offset });
      } catch (_) {
        return;
      }
      if (gen !== inventorySeq) return;
      const raw = data.listings || data.items || [];
      if (!raw.length) return;
      const filtered = liveInventoryListings(raw);
      const base = Array.isArray(untrack(rows)) ? untrack(rows) : [];
      const known = new Set(base.map((row) => String(row.id || row.listingId || '')));
      const fresh = filtered.filter((row) => !known.has(String(row.id || row.listingId || '')));
      if (fresh.length) setRows([...base, ...fresh]);
      if (raw.length < INVENTORY_PAGE_LIMIT) return;
      offset += raw.length;
    }
  }

  async function reload() {
    const uid = listingsUid();
    if (!uid) return;
    const token = await getBearer();
    inventorySeq += 1;
    const data = await fetchSellerListings(uid, token, { limit: 1000 });
    setRows(liveInventoryListings(data.listings || data.items || []));
  }

  // One identity for the listings load: the cached session uid and the
  // restored Firebase uid are the same seller, so their arrival in either
  // order must not cancel a request already in flight.
  const listingsUid = createMemo(() => (signedIn() ? authUid() || accountProfile()?.uid || '' : ''));

  createEffect(
    () => ({ uid: listingsUid(), ...tab() }),
    ({ uid, importTab, settingsTab, collectionTab, locationName }) => {
      document.title = collectionTab
        ? 'Collection · MyPokoin'
        : settingsTab
        ? 'Settings · MyPokoin'
        : locationName
        ? `${locationName} · MyPokoin`
        : (importTab ? 'Export · MyPokoin' : 'MyPokoin · Pokoin');
      // The Collection tab loads holdings, not listings.
      if (!uid || collectionTab) return undefined;
      let cancelled = false;
      let settled = false;
      const gen = ++inventorySeq;
      const attempt = () => getBearer().then(async (token) => {
        const data = await fetchSellerListings(uid, token, { limit: INVENTORY_FIRST_PAGE });
        if (cancelled || settled) return;
        settled = true;
        setError('');
        setRows(liveInventoryListings(data.listings || data.items || []));
        topUpInventory(uid, token, gen).catch(() => {});
      });
      const fail = (err) => {
        if (!cancelled && !settled) setError(err.message || 'Listings failed.');
      };
      attempt().catch(fail);
      // A stalled token refresh or request must not leave the skeleton up for good.
      const retry = setTimeout(() => {
        if (!cancelled && !settled) attempt().catch(fail);
      }, INVENTORY_RETRY_MS);
      return () => {
        cancelled = true;
        clearTimeout(retry);
      };
    },
  );

  // Pricer defaults feed the board's market column and source preselect.
  createEffect(
    () => signedIn() && !tab().importTab && !tab().collectionTab,
    (on) => {
      if (!on) return undefined;
      let cancelled = false;
      getBearer()
        .then((token) => fetchPricingStrategies(token))
        .then((data) => {
          if (!cancelled) setPricerDefaults(() => data.pricerSettings || {});
        })
        .catch(() => {});
      return () => { cancelled = true; };
    },
  );

  createEffect(
    () => (signedIn() && tab().importTab ? previewFormat() : ''),
    (format) => {
      if (!format) return undefined;
      let cancelled = false;
      setBusy(format);
      setError('');
      getBearer()
        .then((token) => exportStockCsv(format, token))
        .then(async (blob) => {
          if (cancelled) return;
          const text = await blob.text();
          if (cancelled) return;
          setPreview(parseCsvPreview(text));
          setPreviewBlob(() => blob);
        })
        .catch((err) => {
          if (!cancelled) {
            setPreview(null);
            setPreviewBlob(null);
            setError(err.message || 'Export preview failed.');
          }
        })
        .finally(() => {
          if (!cancelled) setBusy('');
        });
      return () => { cancelled = true; };
    },
  );

  function onDownload() {
    if (!previewBlob()) return;
    downloadBlob(previewBlob(), `pokoin-stock-${previewFormat()}.csv`);
  }

  const onListings = () => !tab().importTab && !tab().settingsTab && !tab().collectionTab;
  const locationName = () => tab().locationName;

  return (
    <div class="page desk">
      <PageHead kicker="Seller" title="MyPokoin">
        <a class="btn" href="/inventory/scan">Scan cards</a>
        <a class="btn ghost" href="/marketplace">List a card</a>
      </PageHead>
      <StockNav forceActive={locationName() ? 'Listings' : ''} />
      <Alert>{error()}</Alert>

      <Show when={tab().importTab}>
        <DeskPanel title="Export stock">
          <div class="stock-csv-bar" role="group" aria-label="Export format">
            <For each={FORMATS}>
              {(row) => (
                <button
                  type="button"
                  class={row.id === previewFormat() ? 'btn' : 'btn ghost'}
                  aria-pressed={row.id === previewFormat()}
                  disabled={Boolean(busy()) && row.id !== previewFormat()}
                  onClick={() => setPreviewFormat(row.id)}
                >
                  {busy() === row.id ? 'Loading…' : row.label}
                </button>
              )}
            </For>
            <button type="button" class="btn ghost" onClick={onDownload} disabled={!previewBlob() || Boolean(busy())}>
              Download CSV
            </button>
            <a class="btn ghost" href="/mypokoin/spreadsheet">Import in spreadsheet</a>
          </div>
          <Show when={preview()} fallback={<Show when={busy()}><p class="muted">Loading preview…</p></Show>}>
            {(data) => (
              <div class="export-preview-wrap">
                <p class="export-preview-note">
                  {data().rows.length
                    ? `First ${data().rows.length} ${data().rows.length === 1 ? 'row' : 'rows'} of the ${FORMATS.find((row) => row.id === previewFormat())?.label || ''} file.`
                    : 'No listings to export.'}
                </p>
                <table class="export-preview">
                  <thead>
                    <tr>
                      <For each={data().headers}>{(header) => <th>{header}</th>}</For>
                    </tr>
                  </thead>
                  <tbody>
                    <For
                      each={data().rows}
                      fallback={<tr><td colSpan={Math.max(data().headers.length, 1)}>No listings to export.</td></tr>}
                    >
                      {(cells) => (
                        <tr>
                          <For each={data().headers}>{(_header, cellIndex) => <td>{cells[cellIndex()] || ''}</td>}</For>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            )}
          </Show>
        </DeskPanel>
      </Show>

      <Show when={tab().collectionTab}><CollectionHoldings /></Show>

      <Show when={!tab().importTab && !tab().collectionTab && rows() == null && !error()}>
        <DeskPanel title="Listings"><div class="skeleton-line" /><div class="skeleton-line" /></DeskPanel>
      </Show>
      <Show when={tab().settingsTab}>
        <DeskPanel title="Pricer defaults">
          <PricerDefaults settings={pricerDefaults()} onSaved={(next) => setPricerDefaults(() => next)} />
        </DeskPanel>
        <DeskPanel title="Pricing strategies">
          <PricingStrategies onApplied={() => reload().catch(() => {})} />
        </DeskPanel>
      </Show>
      <Switch>
        <Match when={onListings() && rows() && !rows().length}>
          <EmptyDesk
            title={locationName() ? `Nothing stored in ${locationName()}` : 'No live listings'}
            lede={locationName() ? 'Move a listing into this location from its card desk, or scan a new pile.' : 'Scan a pile with your phone, or import a spreadsheet.'}
          >
            <a class="btn" href="/inventory/scan">Scan cards</a>
            <a class="btn ghost" href="/mypokoin/spreadsheet">Sell via spreadsheet</a>
            <a class="btn ghost" href="/mypokoin/import">Export CSV</a>
            <a class="btn ghost" href="/marketplace">Find a card</a>
          </EmptyDesk>
        </Match>
        <Match when={onListings() && locationName() && rows()?.length}>
          <LocationBoard rows={inventoryRowsForLocation(rows(), locationName())} location={locationName()} formatPrice={formatPrice} />
        </Match>
        <Match when={onListings() && !locationName() && rows()?.length}>
          <InventoryBoard
            rows={rows()}
            formatPrice={formatPrice}
            defaultSource={pricerDefaults()?.defaultSource || ''}
            autoMarketColumn={pricerDefaults()?.autoMarketColumn === true}
          />
        </Match>
      </Switch>
    </div>
  );
}

/**
 * Pokémon seller stock desk (market/src/pages/Inventory.jsx): /mypokoin and its
 * import / settings / collection / location tabs. Seller inventory lists only
 * active or paused rows with stock (liveInventoryListings, D00005R).
 */
export default function Inventory() {
  const location = useLocation();
  return (
    <SignedIn from={untrack(() => location.pathname) || '/mypokoin'}>
      <InventoryDesk />
    </SignedIn>
  );
}
