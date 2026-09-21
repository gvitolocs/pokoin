import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { exportStockCsv, fetchSellerListings, formatPkn, importStockCsv } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, DeskPanel, EmptyDesk, PageHead, SessionWait, Thread } from '../components/Desk.jsx';
import {
  inventoryListingHref,
  inventoryListingMeta,
  liveInventoryListings,
} from '../inventory-listings.js';

const FORMATS = [
  { id: 'powertools', label: 'PowerTools' },
  { id: 'cardmarket', label: 'Cardmarket' },
  { id: 'cardtrader', label: 'CardTrader' },
];

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

export default function Inventory() {
  const location = useLocation();
  const { user, ready, signedIn, profile, getBearer } = useAuth();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [format, setFormat] = useState('powertools');
  const [stackSize, setStackSize] = useState(1);
  const [priceMode, setPriceMode] = useState('eur_to_pkn');
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null);
  const [pendingCsv, setPendingCsv] = useState();
  const fileRef = useRef(null);

  async function reload() {
    const uid = user?.uid || profile?.uid;
    if (!signedIn || !uid) return;
    const token = await getBearer();
    const data = await fetchSellerListings(uid, token, { limit: 500 });
    setRows(liveInventoryListings(data.listings || data.items || []));
  }

  useEffect(() => {
    document.title = 'Inventory · Pokoin';
    const uid = user?.uid || profile?.uid;
    if (!signedIn || !uid) return undefined;
    let cancelled = false;
    getBearer()
      .then((token) => fetchSellerListings(uid, token, { limit: 500 }))
      .then((data) => {
        if (!cancelled) setRows(liveInventoryListings(data.listings || data.items || []));
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Listings failed.');
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, user?.uid, profile?.uid, getBearer]);

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
    return <Navigate to={`/auth?from=${encodeURIComponent(location.pathname || '/inventory')}`} replace />;
  }

  const counts = preview?.counts;

  return (
    <div className="page desk">
      <PageHead
        kicker="Seller"
        title="My listings"
      >
        <Link className="btn" to="/inventory/scan">Scan cards</Link>
        <Link className="btn ghost" to="/marketplace">List a card</Link>
      </PageHead>
      <Alert>{error}</Alert>

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
        <p className="stock-csv-hint">
          PowerTools <code>location</code> becomes box stack/position on import.
          Stack size 1 stores <code>box·N</code> and never flashes stack-full.
        </p>
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
                    {p.name} · {p.condition} {p.language} · {formatPkn(p.pricePkn)} · {p.location}
                  </li>
                ))}
                {preview.preview.length > 6 ? <li>…and {preview.preview.length - 6} more</li> : null}
              </ul>
            ) : null}
          </div>
        ) : null}
      </DeskPanel>

      {rows == null && !error ? (
        <DeskPanel title="Inventory"><div className="skeleton-line" /><div className="skeleton-line" /></DeskPanel>
      ) : null}
      {rows && !rows.length ? (
        <EmptyDesk title="No live listings" lede="Scan a pile with your phone, import a CSV, or open a card and use List your card.">
          <Link className="btn" to="/inventory/scan">Scan cards</Link>
          <Link className="btn ghost" to="/marketplace">Find a card</Link>
        </EmptyDesk>
      ) : null}
      {rows?.length ? (
        <DeskPanel flush title={`${rows.length} listing${rows.length === 1 ? '' : 's'}`}>
          <div className="thread-list">
            {rows.map((row) => (
              <Thread
                key={row.id || `${row.cardId}-${row.pricePkn}`}
                to={inventoryListingHref(row)}
                title={row.cardName || row.name || 'Listing'}
                meta={inventoryListingMeta(row, formatPkn)}
              />
            ))}
          </div>
        </DeskPanel>
      ) : null}
    </div>
  );
}
