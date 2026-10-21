import { createEffect, createMemo, createSignal, For, Match, Show, Switch, untrack } from 'solid-js';
import { useLocation, useSearchParams } from '@solidjs/router';
import { exportStockCsv, fetchPricingStrategies } from '@market/api.js';
import { inventoryRowsForLocation, summarizeLiveInventory } from '@market/inventory-listings.js';
import { game } from '@market/game.js';
import { hasStoredBooks, inventoryBooks, readCachedPricerSettings, writeCachedPricerSettings } from '@market/inventory-book.js';
import { formatPknNumber } from '@market/pkn.js';
import { formatSellerPrice } from '@market/seller-currency.js';
import '@market/export-preview.css';
import { Alert, DeskPanel, EmptyDesk } from '../components/Desk.jsx';
import CollectionHoldings from '../components/inventory/CollectionHoldings.jsx';
import InventoryBoard from '../components/inventory/InventoryBoard.jsx';
import LocationBoard from '../components/inventory/LocationBoard.jsx';
import PricingStrategies, { PricerDefaults } from '../components/inventory/PricingStrategies.jsx';
import WipeAllInventory from '../components/profile/WipeAllInventory.jsx';
import SignedIn from '../components/SignedIn.jsx';
import StockNav from '../components/StockNav.jsx';
import {
  allowMypokoinPreview,
  MYPOKOIN_PREVIEW_BANNER,
  previewListings,
  previewPricer,
  previewComps,
  previewStrategies,
} from './mypokoin-preview-fixture.js';
import { loadOwnerBook } from '../lib/owner-book.js';
import { accountProfile } from '../stores/account.js';
import { authUid, getBearer, signedIn } from '../stores/auth.js';
import { sellerCurrency } from '../stores/buyer.js';

const FORMATS = [
  { id: 'powertools', label: 'Power Tools' },
  { id: 'cardmarket', label: 'Cardmarket' },
  { id: 'cardtrader', label: 'CardTrader' },
  { id: 'tcgplayer', label: 'TCGPlayer' },
];

const LISTING_METRICS = ['Live listings', 'Cards in stock', 'Total asking', 'Paused'];

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

function InventoryDesk(props) {
  const location = useLocation();
  const tab = createMemo(() => tabOf(location.pathname), {
    equals: (a, b) => a.importTab === b.importTab && a.settingsTab === b.settingsTab
      && a.collectionTab === b.collectionTab && a.locationName === b.locationName,
  });
  // PKN opt-out sellers read their prices in local currency.
  const formatPrice = (pkn) => formatSellerPrice(pkn, sellerCurrency());
  const [rows, setRows] = createSignal(props.preview ? previewListings() : null);
  // A first load paints page by page; its totals wait for the whole book.
  const [partial, setPartial] = createSignal(false);
  // A stored book answers from IndexedDB in a few ms: no skeleton flash before it.
  const [waitShown, setWaitShown] = createSignal(Boolean(props.preview) || !hasStoredBooks());
  if (!waitShown()) setTimeout(() => setWaitShown(true), 300);
  const [error, setError] = createSignal('');
  const [previewFormat, setPreviewFormat] = createSignal('powertools');
  const [preview, setPreview] = createSignal(null);
  const [previewBlob, setPreviewBlob] = createSignal(null);
  const [busy, setBusy] = createSignal('');
  const [collectionStats, setCollectionStats] = createSignal(null);
  const selectedGame = game().id;
  let paintedKey = '';

  // One identity for the listings load: the cached session uid and the
  // restored Firebase uid are the same seller, so their arrival in either
  // order must not cancel a request already in flight.
  const listingsUid = createMemo(() => (signedIn() ? authUid() || accountProfile()?.uid || '' : ''));
  // The seller's last pricer settings paint the market column with the book.
  const [pricerDefaults, setPricerDefaults] = createSignal(
    props.preview ? previewPricer() : readCachedPricerSettings(untrack(listingsUid)),
  );

  function readBook(uid, onUpdate, force = false) {
    return loadOwnerBook(uid, selectedGame, onUpdate, { force });
  }

  async function reload() {
    const uid = listingsUid();
    if (!uid) return;
    inventoryBooks.invalidate(uid, selectedGame);
    return readBook(uid, (next, complete = true) => {
      if (listingsUid() !== uid) return;
      setPartial(!complete);
      setRows(next);
    }, true);
  }

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
      if (props.preview) return undefined;
      if (!uid || collectionTab) return undefined;
      let cancelled = false;
      const key = `${uid}:${selectedGame}`;
      if (paintedKey !== key) {
        paintedKey = key;
        // Another seller's rows never stay on screen; this seller's book
        // paints now (memory) or as soon as IndexedDB answers.
        setRows(inventoryBooks.peek(uid, selectedGame)?.rows ?? null);
      }
      readBook(uid, (next, complete = true) => {
        if (cancelled) return;
        setError('');
        setPartial(!complete);
        setRows(next);
      }).catch((err) => {
        if (!cancelled) setError(err.message || 'Listings failed.');
      });
      return () => { cancelled = true; };
    },
  );

  // Pricer defaults feed the board's market column and source preselect.
  createEffect(
    () => (!tab().importTab && !tab().collectionTab ? listingsUid() : ''),
    (uid) => {
      if (props.preview || !uid) return undefined;
      let cancelled = false;
      getBearer()
        .then((token) => fetchPricingStrategies(token))
        .then((data) => {
          if (cancelled) return;
          const settings = data.pricerSettings || {};
          writeCachedPricerSettings(uid, settings);
          setPricerDefaults(() => settings);
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
  const metrics = () => {
    if (tab().collectionTab) {
      const stats = collectionStats();
      if (!stats) return [];
      return [
        { value: stats.owned, label: 'Cards owned' },
        { value: stats.held, label: 'Held back' },
        { value: stats.listed, label: 'Listed' },
      ];
    }
    const live = rows();
    if (!onListings()) return [];
    // Hold the tiles' row while the first book loads, so it does not push the page.
    if (!live || partial()) return LISTING_METRICS.map((label) => ({ value: '—', label }));
    const scoped = locationName() ? inventoryRowsForLocation(live, locationName()) : live;
    const summary = summarizeLiveInventory(scoped);
    const paused = scoped.filter((row) => String(row.status || '').toLowerCase() === 'paused').length;
    return [
      { value: summary.listings, label: LISTING_METRICS[0] },
      { value: summary.cards, label: LISTING_METRICS[1] },
      { value: `${formatPknNumber(summary.listedPkn)} PKN`, label: LISTING_METRICS[2] },
      { value: paused, label: LISTING_METRICS[3] },
    ];
  };

  return (
    <div class="page desk mypokoin">
      <Show when={props.preview}>
        <p class="seller-preview-banner" role="status">{MYPOKOIN_PREVIEW_BANNER}</p>
      </Show>
      <StockNav
        lede="Live listings, the cards you hold, and what you export."
        metrics={metrics()}
        forceActive={locationName() ? 'Listings' : ''}
      >
        <a class="btn" href="/inventory/scan">Scan cards</a>
        <a class="btn ghost" href="/marketplace">List a card</a>
      </StockNav>
      <Alert>{error()}</Alert>

      <Show when={tab().importTab}>
        <DeskPanel title="Export stock">
          <p class="mypokoin-help">Download the live book as CSV. The table below is the file you will save.</p>
          <div class="stock-csv-bar" role="group" aria-label="Export format">
            <For each={FORMATS}>
              {(row) => (
                <button
                  type="button"
                  class={row.id === previewFormat() ? 'btn' : 'btn ghost'}
                  aria-pressed={String(row.id === previewFormat())}
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

      <Show when={tab().collectionTab}><CollectionHoldings preview={props.preview} onStats={setCollectionStats} /></Show>

      <Show when={!tab().importTab && !tab().collectionTab && !tab().settingsTab && rows() == null && !error()}>
        {/* First visit only (later visits paint the stored book): holds the
            footer below the fold so the board does not push it. */}
        <Show when={waitShown()} fallback={<div class="mypokoin-wait" aria-hidden="true" />}>
          <DeskPanel title="Listings" class="mypokoin-wait"><div class="skeleton-line" /><div class="skeleton-line" /></DeskPanel>
        </Show>
      </Show>
      <Show when={tab().settingsTab}>
        <div class="mypokoin-settings">
          <section class="mypokoin-card">
            <div class="mypokoin-panel-head">
              <div>
                <h2>Shipping</h2>
                <p class="mypokoin-help">Ship-from country is saved on your profile and copied onto every physical listing.</p>
              </div>
              <a class="btn" href="/profile">Edit shipping</a>
            </div>
          </section>
          <section class="mypokoin-card">
            <div class="mypokoin-panel-head">
              <div>
                <h2>Pricing defaults</h2>
                <p class="mypokoin-help">Which market the listings board opens on.</p>
              </div>
            </div>
            <PricerDefaults
              preview={props.preview}
              settings={pricerDefaults()}
              onSaved={(next) => setPricerDefaults(() => next)}
            />
          </section>
          <section class="mypokoin-card">
            <PricingStrategies
              preview={props.preview}
              previewStrategies={previewStrategies()}
              onApplied={() => reload().catch(() => {})}
            />
          </section>
          <section class="mypokoin-card">
            <div class="mypokoin-panel-head">
              <div>
                <h2>Connections</h2>
                <p class="mypokoin-help">CardTrader and Power Tools stay linked from Profile. Zero picking uses the same seller.</p>
              </div>
              <a class="btn" href="/profile">Open Profile</a>
            </div>
          </section>
          <section class="mypokoin-card is-danger">
            <div class="mypokoin-panel-head">
              <div>
                <h2>Danger zone</h2>
                <p class="mypokoin-help">Deletes every Pokoin listing. CardTrader stock stays until you sync again.</p>
              </div>
            </div>
            <div class="danger-row">
              <Show
                when={!props.preview}
                fallback={<button type="button" class="btn ghost" disabled>Delete all Pokoin listings</button>}
              >
                <WipeAllInventory onError={(message) => setError(message)} />
              </Show>
            </div>
          </section>
        </div>
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
            showSummary={false}
            defaultSource={props.preview ? '' : (pricerDefaults()?.defaultSource || '')}
            autoMarketColumn={pricerDefaults()?.autoMarketColumn === true}
            preview={props.preview}
            previewStrategies={props.preview ? previewStrategies() : undefined}
            previewComps={props.preview ? previewComps() : undefined}
            onApplied={() => reload().catch(() => {})}
          />
        </Match>
      </Switch>
    </div>
  );
}

/**
 * Pokémon seller stock desk: /mypokoin and its
 * import / settings / collection / location tabs. Seller inventory lists only
 * active or paused rows with stock (liveInventoryListings, D00005R).
 */
export default function Inventory() {
  const location = useLocation();
  const [params] = useSearchParams();
  return (
    <Show
      when={untrack(() => allowMypokoinPreview(params))}
      fallback={(
        <SignedIn early from={untrack(() => location.pathname) || '/mypokoin'}>
          <InventoryDesk />
        </SignedIn>
      )}
    >
      <InventoryDesk preview />
    </Show>
  );
}
