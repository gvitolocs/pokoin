import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useMatch } from 'react-router-dom';
import { exportStockCsv, fetchPricingStrategies, fetchSellerListings, importStockCsv } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useSellerCurrency } from '../use-seller-currency.js';
import { formatSellerPrice } from '../seller-currency.js';
import { Alert, DeskPanel, EmptyDesk, PageHead, SessionWait } from '../components/Desk.jsx';
import InventoryBoard from '../components/InventoryBoard.jsx';
import LocationBoard from '../components/LocationBoard.jsx';
import PricingStrategies, { PricerDefaults } from '../components/PricingStrategies.jsx';
import StockNav from '../components/StockNav.jsx';
import WipeAllInventory from '../components/WipeAllInventory.jsx';
import { inventoryRowsForLocation, liveInventoryListings } from '../inventory-listings.js';

const FORMATS = [
  { id: 'powertools', label: 'PowerTools' },
  { id: 'cardmarket', label: 'Cardmarket' },
  { id: 'cardtrader', label: 'CardTrader' },
];

// Paint the board off the first raw page, then top up the rest in the
// background — one round trip to first row instead of the full inventory.
const INVENTORY_FIRST_PAGE = 200;
const INVENTORY_PAGE_LIMIT = 1000;

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadText(text, filename) {
  downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), filename);
}

/** Pokemon seller stock desk — live path is /mypokoin (legacy /inventory redirects). */
export default function Inventory() {
  const location = useLocation();
  const onImportTab = Boolean(useMatch({ path: '/mypokoin/import', end: true }));
  const onSettingsTab = Boolean(useMatch({ path: '/mypokoin/settings', end: true }));
  const locationMatch = useMatch({ path: '/mypokoin/location/:location', end: false });
  let locationName = locationMatch ? decodeURIComponent(locationMatch.params.location || '') : '';
  // The auth bounce can double-encode the · separator — decode until stable.
  if (locationName.includes('%')) {
    try { locationName = decodeURIComponent(locationName); } catch (_) { /* keep */ }
  }
  const { user, ready, signedIn, profile, getBearer } = useAuth();
  // PKN opt-out sellers read their prices in local currency.
  const { currency: priceCurrency } = useSellerCurrency();
  const formatPrice = (pkn) => formatSellerPrice(pkn, priceCurrency);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [format, setFormat] = useState('powertools');
  const [stackSize, setStackSize] = useState(1);
  const [priceMode, setPriceMode] = useState('eur_to_pkn');
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null);
  const [pendingCsv, setPendingCsv] = useState();
  const [message, setMessage] = useState('');
  const fileRef = useRef(null);
  // Bumped by reload() so a stale background top-up stops writing rows.
  const inventorySeq = useRef(0);

  async function topUpInventory(uid, token, gen) {
    let offset = INVENTORY_FIRST_PAGE;
    for (;;) {
      let data;
      try {
        data = await fetchSellerListings(uid, token, { limit: INVENTORY_PAGE_LIMIT, offset });
      } catch (_) {
        return;
      }
      if (gen !== inventorySeq.current) return;
      const raw = data.listings || data.items || [];
      if (!raw.length) return;
      const filtered = liveInventoryListings(raw);
      setRows((current) => {
        const base = Array.isArray(current) ? current : [];
        const known = new Set(base.map((row) => String(row.id || row.listingId || '')));
        const fresh = filtered.filter((row) => !known.has(String(row.id || row.listingId || '')));
        return fresh.length ? [...base, ...fresh] : current;
      });
      if (raw.length < INVENTORY_PAGE_LIMIT) return;
      offset += raw.length;
    }
  }

  async function reload() {
    const uid = user?.uid || profile?.uid;
    if (!signedIn || !uid) return;
    const token = await getBearer();
    inventorySeq.current += 1;
    const data = await fetchSellerListings(uid, token, { limit: 1000 });
    setRows(liveInventoryListings(data.listings || data.items || []));
  }

  useEffect(() => {
    document.title = onSettingsTab
      ? 'Settings · MyPokoin'
      : locationName
      ? `${locationName} · MyPokoin`
      : (onImportTab ? 'Import / export · MyPokoin' : 'MyPokoin · Pokoin');
    const uid = user?.uid || profile?.uid;
    if (!signedIn || !uid) return undefined;
    let cancelled = false;
    const gen = ++inventorySeq.current;
    getBearer()
      .then((token) => fetchSellerListings(uid, token, { limit: INVENTORY_FIRST_PAGE }))
      .then((data) => {
        if (cancelled) return;
        setRows(liveInventoryListings(data.listings || data.items || []));
        topUpInventory(uid, token, gen).catch(() => {});
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Listings failed.');
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, user?.uid, profile?.uid, getBearer, onImportTab, locationName, onSettingsTab]);

  // Pricer defaults feed the board's market column and source preselect.
  const [pricerDefaults, setPricerDefaults] = useState(null);
  useEffect(() => {
    if (!signedIn || onImportTab) return undefined;
    let cancelled = false;
    getBearer()
      .then((token) => fetchPricingStrategies(token))
      .then((data) => {
        if (!cancelled) setPricerDefaults(data.pricerSettings || {});
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [signedIn, getBearer, onImportTab, onSettingsTab]);

  async function onExport() {
    setError('');
    setBusy('export');
    try {
      const token = await getBearer();
      const blob = await exportStockCsv(format, token);
      downloadBlob(blob, `pokoin-stock-${format}.csv`);
    } catch (err) {
      setError(err.message || 'Export failed.');
    } finally {
      setBusy('');
    }
  }

  async function runImport(fileText, { dryRun }) {
    setError('');
    setBusy(dryRun ? 'preview' : 'import');
    try {
      const token = await getBearer();
      const result = await importStockCsv({
        csv: fileText,
        format,
        stackSize,
        priceMode,
        dryRun,
        token,
      });
      setPreview(result);
      if (!dryRun) {
        await reload();
      }
    } catch (err) {
      setError(err.message || 'Import failed.');
    } finally {
      setBusy('');
    }
  }

  async function onPickFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const text = await file.text();
    setPendingCsv(text);
    await runImport(text, { dryRun: true });
  }

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={`/auth?from=${encodeURIComponent(location.pathname || '/mypokoin')}`} replace />;
  }

  const counts = preview?.counts;

  return (
    <div className="page desk">
      <PageHead
        kicker="Seller"
        title="MyPokoin"
      >
        <Link className="btn" to="/inventory/scan">Scan cards</Link>
        <Link className="btn ghost" to="/marketplace">List a card</Link>
      </PageHead>
      <StockNav forceActive={locationName ? 'Listings' : ''} />
      <Alert>{error}</Alert>
      {message ? <p className="ct-connect-ok" role="status">{message}</p> : null}

      {onImportTab ? (
        <DeskPanel title="Import / export stock">
          <div className="stock-csv-bar">
            <label>
              Format
              <select value={format} onChange={(e) => setFormat(e.target.value)} disabled={Boolean(busy)}>
                {FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </label>
            <label title="Used when importing: size 1 = one card per divider (no stack-full UI)">
              Stack size
              <input
                type="number"
                min={1}
                max={100}
                value={stackSize}
                onChange={(e) => setStackSize(Math.max(1, Number(e.target.value) || 1))}
                disabled={Boolean(busy)}
              />
            </label>
            <label>
              Price
              <select value={priceMode} onChange={(e) => setPriceMode(e.target.value)} disabled={Boolean(busy)}>
                <option value="eur_to_pkn">EUR → PKN (×200)</option>
                <option value="as_pkn">Already PKN</option>
              </select>
            </label>
            <button type="button" className="btn ghost" onClick={onExport} disabled={Boolean(busy)}>
              {busy === 'export' ? 'Exporting…' : 'Export CSV'}
            </button>
            <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={Boolean(busy)}>
              {busy === 'preview' ? 'Reading…' : 'Import CSV…'}
            </button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={onPickFile} />
          </div>
          {preview ? (
            <div className="stock-csv-preview">
              <p>
                {preview.dryRun ? 'Preview' : 'Import'} · {preview.format}
                {counts ? ` · ${counts.total} rows · ${counts.preview || counts.created || 0} ok · ${counts.failed} failed · ${counts.skipped || 0} skipped` : ''}
              </p>
              {preview.dryRun && pendingCsv && (counts?.preview > 0) ? (
                <button
                  type="button"
                  className="btn"
                  disabled={Boolean(busy)}
                  onClick={() => runImport(pendingCsv, { dryRun: false })}
                >
                  {busy === 'import' ? 'Importing…' : `Confirm import (${counts.preview})`}
                </button>
              ) : null}
              {preview.failedCsv ? (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => downloadText(preview.failedCsv, `pokoin-import-failed-${preview.format}.csv`)}
                >
                  Download failed rows
                </button>
              ) : null}
              {preview.failed?.length ? (
                <ul className="stock-csv-failed">
                  {preview.failed.slice(0, 8).map((f) => (
                    <li key={`${f.line}-${f.error}`}>Line {f.line}: {f.error}</li>
                  ))}
                  {preview.failed.length > 8 ? <li>…and {preview.failed.length - 8} more</li> : null}
                </ul>
              ) : null}
              {preview.preview?.length ? (
                <ul className="stock-csv-ok">
                  {preview.preview.slice(0, 6).map((p) => (
                    <li key={`${p.line}-${p.cardId}`}>
                      {p.name} · {p.condition} {p.language} · {formatPrice(p.pricePkn)} · {p.location}
                    </li>
                  ))}
                  {preview.preview.length > 6 ? <li>…and {preview.preview.length - 6} more</li> : null}
                </ul>
              ) : null}
            </div>
          ) : null}
          <WipeAllInventory
            disabled={Boolean(busy)}
            onError={(text) => {
              setError(text || '');
              if (text) setMessage('');
            }}
            onMessage={(text) => {
              setMessage(text || '');
              setError('');
            }}
            onWiped={() => {
              setRows([]);
              reload().catch(() => {});
            }}
          />
        </DeskPanel>
      ) : null}

      {!onImportTab && rows == null && !error ? (
        <DeskPanel title="Listings"><div className="skeleton-line" /><div className="skeleton-line" /></DeskPanel>
      ) : null}
      {onSettingsTab ? (
        <>
          <DeskPanel title="Pricer defaults">
            <PricerDefaults
              settings={pricerDefaults}
              onSaved={(next) => setPricerDefaults(next)}
            />
          </DeskPanel>
          <DeskPanel title="Pricing strategies">
            <PricingStrategies onApplied={() => reload().catch(() => {})} />
          </DeskPanel>
        </>
      ) : null}
      {!onImportTab && !onSettingsTab && rows && !rows.length ? (
        <EmptyDesk
          title={locationName ? `Nothing stored in ${locationName}` : 'No live listings'}
          lede={locationName ? 'Move a listing into this location from its card desk, or scan a new pile.' : 'Scan a pile with your phone, import a CSV, or open a card and use List your card.'}>
          <Link className="btn" to="/inventory/scan">Scan cards</Link>
          <Link className="btn ghost" to="/mypokoin/import">Import CSV</Link>
          <Link className="btn ghost" to="/marketplace">Find a card</Link>
        </EmptyDesk>
      ) : null}
      {!onImportTab && !onSettingsTab && locationName && rows?.length ? (
        <LocationBoard
          rows={inventoryRowsForLocation(rows, locationName)}
          location={locationName}
          formatPrice={formatPrice}
        />
      ) : null}
      {!onImportTab && !onSettingsTab && !locationName && rows?.length ? (
        <InventoryBoard
          rows={rows}
          formatPrice={formatPrice}
          defaultSource={pricerDefaults?.defaultSource || ''}
          autoMarketColumn={pricerDefaults?.autoMarketColumn === true}
        />
      ) : null}
    </div>
  );
}
