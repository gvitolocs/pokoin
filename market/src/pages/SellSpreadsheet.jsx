import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { importStockCsv } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, DeskPanel, PageHead, SessionWait } from '../components/Desk.jsx';
import StockNav from '../components/StockNav.jsx';
import { game as currentGame } from '../game.js';
import { fileToCsv, SPREADSHEET_ACCEPT, SPREADSHEET_TYPES_LABEL, textToCsv } from '../spreadsheet-file.js';
import { FORMAT_LABEL, importPayload, previewSpreadsheet, SPREADSHEET_PAGE } from '../spreadsheet-rows.js';
import {
  formatImportWhen,
  IMPORT_COLUMNS,
  loadSpreadsheetImports,
  nextImportId,
  recordFromImport,
  saveSpreadsheetImports,
} from '../spreadsheet-imports.js';
import '../sell-spreadsheet.css';

function UploadIcon() {
  return (
    <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
      <path fill="currentColor" d="M24 6.5 15.2 16h5.3v11h7V16h5.3L24 6.5zM12 32h24v3.2H12V32zm0 6.2h24v3.2H12v-3.2zM12 32v3.2h3.2V32H12zm20.8 0v3.2H36V32h-3.2z" />
    </svg>
  );
}

function PasteIcon() {
  return (
    <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
      <path fill="currentColor" d="M14 12h16a2 2 0 0 1 2 2v22H12V14a2 2 0 0 1 2-2zm6-6h16a2 2 0 0 1 2 2v22h-4V10H18V6z" />
    </svg>
  );
}

function statusLabel(record, busyId) {
  if (busyId && busyId === record.id) return 'Importing…';
  return record.status;
}

function allowLayoutPreview(search) {
  if (!import.meta.env.DEV) return false;
  return new URLSearchParams(search).has('sheetPreview');
}

export default function SellSpreadsheet() {
  const location = useLocation();
  const preview = allowLayoutPreview(location.search);
  const { ready, signedIn, getBearer } = useAuth();
  const fileRef = useRef(null);
  const [saved, setSaved] = useState(() => loadSpreadsheetImports());
  const [sheet, setSheet] = useState(null);
  const [ctIntent, setCtIntent] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    document.title = 'Sell via spreadsheet · Pokoin';
  }, []);

  if (!ready && !preview) return <SessionWait />;
  if (!signedIn && !preview) {
    return <Navigate to={`/auth?from=${encodeURIComponent(location.pathname || '/mypokoin/spreadsheet')}`} replace />;
  }

  const rows = saved;
  const page = sheet?.page || 0;
  const start = page * SPREADSHEET_PAGE;
  const visibleCards = sheet ? sheet.rows.slice(start, start + SPREADSHEET_PAGE) : [];
  const pageCount = sheet ? Math.ceil(sheet.rows.length / SPREADSHEET_PAGE) : 0;

  function showSheet(csv, label) {
    const preview = previewSpreadsheet(csv);
    if (!preview.format || !preview.rows.length) {
      throw new Error('Unrecognized spreadsheet. Use columns we can read, such as name, set, and collector number.');
    }
    setSheet({ label, csv, ...preview, page: 0 });
    setCtIntent('');
    const located = preview.hasLocation ? ' · locations kept' : '';
    setNote(`${FORMAT_LABEL[preview.format]} · ${preview.rows.length.toLocaleString('en-US')} cards${located}`);
  }

  async function stage(csv, label) {
    setError('');
    setNote('');
    setBusy('read');
    try {
      showSheet(csv, label);
    } catch (err) {
      setSheet(null);
      setError(err.message || 'Could not read that spreadsheet.');
    } finally {
      setBusy('');
    }
  }

  async function onFile(file) {
    if (!file || busy) return;
    setBusy('read');
    setError('');
    try {
      const csv = await fileToCsv(file);
      if (!csv.trim()) throw new Error('That file has no rows.');
      await stage(csv, file.name || 'spreadsheet');
    } catch (err) {
      setBusy('');
      setError(err.message || 'Could not read that file.');
    }
  }

  async function onPasteSubmit() {
    if (busy) return;
    setBusy('read');
    setError('');
    try {
      const csv = await textToCsv(pasteText);
      setPasteOpen(false);
      await stage(csv, 'Pasted text');
    } catch (err) {
      setBusy('');
      setError(err.message || 'Could not read that text.');
    }
  }

  async function confirmPending() {
    if (!sheet || busy) return;
    if (sheet.cardtraderLinks && ctIntent !== 'link' && ctIntent !== 'import') {
      setError('Choose whether to link these cards to CardTrader or import them from CardTrader.');
      setBusy('');
      return;
    }
    setBusy('list');
    setError('');
    try {
      const token = await getBearer();
      const payload = importPayload(sheet);
      const result = await importStockCsv({
        csv: payload.csv,
        format: payload.format,
        dryRun: false,
        preserveLocation: true,
        cardtraderIntent: sheet.cardtraderLinks ? ctIntent : '',
        token,
      });
      const id = nextImportId(saved);
      const record = recordFromImport({ id, game: currentGame().name, result });
      const next = [record, ...saved];
      setSaved(next);
      saveSpreadsheetImports(next);
      setNote(record.status === 'Failed'
        ? 'Nothing was listed.'
        : `Listed ${record.created.toLocaleString('en-US')} of ${sheet.rows.length.toLocaleString('en-US')} cards.`);
    } catch (err) {
      setError(err.message || 'Import failed.');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="page desk sell-sheet">
      <PageHead
        kicker="Seller"
        title="Sell via spreadsheet"
        lede="Upload a stock file or paste rows from Power Tools, CardTrader, Cardmarket, TCGPlayer, or your own sheet. Check the cards, then list them in one go."
      />
      <StockNav />
      <Alert>{error}</Alert>
      <DeskPanel title="Upload">
        <div className="sell-sheet-drops">
          <button
            type="button"
            className={`sell-sheet-drop is-file${dragOver ? ' is-over' : ''}`}
            disabled={Boolean(busy)}
            onClick={() => fileRef.current?.click()}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              onFile(event.dataTransfer?.files?.[0]);
            }}
          >
            <UploadIcon />
            <span>
              Drag your file here or click to browse files. Supported files: {SPREADSHEET_TYPES_LABEL}
            </span>
          </button>
          <button
            type="button"
            className="sell-sheet-drop is-paste"
            disabled={Boolean(busy)}
            onClick={() => {
              setPasteText('');
              setPasteOpen(true);
            }}
          >
            <PasteIcon />
            <span>Copy and paste a text</span>
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={SPREADSHEET_ACCEPT}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            onFile(file);
          }}
        />
        {note ? <p className="sell-sheet-note" role="status">{note}</p> : null}
        {sheet?.cardtraderLinks ? (
          <div className="sell-sheet-ct" role="group" aria-labelledby="ct-link-title">
            <h3 id="ct-link-title">CardTrader links in this file</h3>
            <p>Link the current Pokoin cards to those CardTrader listings, or import the cards from CardTrader.</p>
            <p className="sell-sheet-warn">If a card is already on both Pokoin and CardTrader, linking or importing can create duplicates.</p>
            <div className="sell-sheet-confirm">
              <button
                type="button"
                className={ctIntent === 'link' ? 'btn' : 'btn ghost'}
                onClick={() => setCtIntent('link')}
              >
                Link to CardTrader
              </button>
              <button
                type="button"
                className={ctIntent === 'import' ? 'btn' : 'btn ghost'}
                onClick={() => setCtIntent('import')}
              >
                Import from CardTrader
              </button>
            </div>
          </div>
        ) : null}
        {sheet ? (
          <div className="sell-sheet-confirm">
            <button
              type="button"
              className="btn"
              disabled={Boolean(busy) || (sheet.cardtraderLinks && !ctIntent)}
              onClick={confirmPending}
            >
              {busy === 'list' ? 'Listing…' : `List ${sheet.rows.length.toLocaleString('en-US')} cards`}
            </button>
            <button type="button" className="btn ghost" disabled={Boolean(busy)} onClick={() => setSheet(null)}>
              Dismiss
            </button>
          </div>
        ) : null}
      </DeskPanel>

      {sheet ? (
        <DeskPanel title={`${FORMAT_LABEL[sheet.format]} · ${sheet.rows.length.toLocaleString('en-US')} cards`}>
          <div className="sell-sheet-table-wrap">
            <table className="sell-sheet-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Set</th>
                  <th scope="col">Number</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Condition</th>
                  <th scope="col">Language</th>
                  <th scope="col">Price</th>
                  {sheet.hasLocation ? <th scope="col">Location</th> : null}
                </tr>
              </thead>
              <tbody>
                {visibleCards.map((card, index) => (
                  <tr key={`${start + index}-${card.name}-${card.number}`}>
                    <td>{card.name}</td>
                    <td>{card.setName}</td>
                    <td>{card.number}</td>
                    <td>{card.quantity}</td>
                    <td>{card.condition}</td>
                    <td>{card.language}</td>
                    <td>{card.price}</td>
                    {sheet.hasLocation ? <td>{card.location}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pageCount > 1 ? (
            <div className="sell-sheet-pager">
              <button
                type="button"
                className="btn ghost"
                disabled={page === 0}
                onClick={() => setSheet((current) => ({ ...current, page: current.page - 1 }))}
              >
                Previous
              </button>
              <span>
                {start + 1}
                –
                {Math.min(start + SPREADSHEET_PAGE, sheet.rows.length)}
                {' of '}
                {sheet.rows.length.toLocaleString('en-US')}
              </span>
              <button
                type="button"
                className="btn ghost"
                disabled={page + 1 >= pageCount}
                onClick={() => setSheet((current) => ({ ...current, page: current.page + 1 }))}
              >
                Next
              </button>
            </div>
          ) : null}
        </DeskPanel>
      ) : null}

      <DeskPanel title="Recent imports">
        <div className="sell-sheet-table-wrap">
          <table className="sell-sheet-table">
            <thead>
              <tr>
                {IMPORT_COLUMNS.map(([key, label]) => <th key={key} scope="col">{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.length ? null : (
                <tr>
                  <td className="sell-sheet-empty" colSpan={IMPORT_COLUMNS.length}>
                    No imports yet. Your spreadsheet imports show up here.
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.id}</td>
                  <td>{row.game}</td>
                  <td>{row.mode}</td>
                  <td>{row.rows}</td>
                  <td>{row.errors}</td>
                  <td>{row.warnings}</td>
                  <td>{row.created}</td>
                  <td>{row.updated}</td>
                  <td>{row.deleted}</td>
                  <td>{formatImportWhen(row.createdAt)}</td>
                  <td>{statusLabel(row, busy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DeskPanel>

      {pasteOpen ? (
        <div className="sell-sheet-modal" role="presentation" onClick={() => setPasteOpen(false)}>
          <form
            className="sell-sheet-dialog"
            role="dialog"
            aria-labelledby="paste-sheet-title"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              onPasteSubmit();
            }}
          >
            <h2 id="paste-sheet-title">Copy and paste a text</h2>
            <textarea
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              placeholder="Paste CSV or spreadsheet rows"
              autoFocus
            />
            <div className="sell-sheet-dialog-actions">
              <button type="button" className="btn ghost" onClick={() => setPasteOpen(false)}>Cancel</button>
              <button type="submit" className="btn" disabled={Boolean(busy) || !pasteText.trim()}>
                {busy === 'read' ? 'Reading…' : 'Import'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
