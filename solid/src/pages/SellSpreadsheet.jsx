import { createSignal, For, Show, untrack } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { importStockCsv } from '@market/api.js';
import { game as currentGame } from '@market/game.js';
import { fileToCsv, SPREADSHEET_ACCEPT, SPREADSHEET_TYPES_LABEL, textToCsv } from '@market/spreadsheet-file.js';
import {
  formatImportWhen,
  IMPORT_COLUMNS,
  loadSpreadsheetImports,
  nextImportId,
  recordFromImport,
  saveSpreadsheetImports,
} from '@market/spreadsheet-imports.js';
import { FORMAT_LABEL, importPayload, previewSpreadsheet, SPREADSHEET_PAGE } from '@market/spreadsheet-rows.js';
import '@market/sell-spreadsheet.css';
import { Alert, DeskPanel, PageHead } from '../components/Desk.jsx';
import SignedIn from '../components/SignedIn.jsx';
import StockNav from '../components/StockNav.jsx';
import { getBearer } from '../stores/auth.js';

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

function SpreadsheetDesk() {
  let fileInput;
  const [saved, setSaved] = createSignal(loadSpreadsheetImports());
  const [sheet, setSheet] = createSignal(null);
  const [ctIntent, setCtIntent] = createSignal('');
  const [pasteOpen, setPasteOpen] = createSignal(false);
  const [pasteText, setPasteText] = createSignal('');
  const [dragOver, setDragOver] = createSignal(false);
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  const [note, setNote] = createSignal('');

  const page = () => sheet()?.page || 0;
  const start = () => page() * SPREADSHEET_PAGE;
  const visibleCards = () => (sheet() ? sheet().rows.slice(start(), start() + SPREADSHEET_PAGE) : []);
  const pageCount = () => (sheet() ? Math.ceil(sheet().rows.length / SPREADSHEET_PAGE) : 0);

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
    if (!file || busy()) return;
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
    if (busy()) return;
    setBusy('read');
    setError('');
    try {
      const csv = await textToCsv(pasteText());
      setPasteOpen(false);
      await stage(csv, 'Pasted text');
    } catch (err) {
      setBusy('');
      setError(err.message || 'Could not read that text.');
    }
  }

  async function confirmPending() {
    const current = sheet();
    if (!current || busy()) return;
    if (current.cardtraderLinks && ctIntent() !== 'link' && ctIntent() !== 'import') {
      setError('Choose whether to link these cards to CardTrader or import them from CardTrader.');
      setBusy('');
      return;
    }
    setBusy('list');
    setError('');
    try {
      const token = await getBearer();
      const payload = importPayload(current);
      const result = await importStockCsv({
        csv: payload.csv,
        format: payload.format,
        dryRun: false,
        preserveLocation: true,
        cardtraderIntent: current.cardtraderLinks ? ctIntent() : '',
        token,
      });
      const id = nextImportId(saved());
      const record = recordFromImport({ id, game: currentGame().name, result });
      const next = [record, ...saved()];
      setSaved(next);
      saveSpreadsheetImports(next);
      setNote(record.status === 'Failed'
        ? 'Nothing was listed.'
        : `Listed ${record.created.toLocaleString('en-US')} of ${current.rows.length.toLocaleString('en-US')} cards.`);
    } catch (err) {
      setError(err.message || 'Import failed.');
    } finally {
      setBusy('');
    }
  }

  const turnPage = (step) => setSheet((current) => ({ ...current, page: current.page + step }));

  return (
    <div class="page desk sell-sheet">
      <PageHead
        kicker="Seller"
        title="Sell via spreadsheet"
        lede="Upload a stock file or paste rows from Power Tools, CardTrader, Cardmarket, TCGPlayer, or your own sheet. Check the cards, then list them in one go."
      />
      <StockNav />
      <Alert>{error()}</Alert>
      <DeskPanel title="Upload">
        <div class="sell-sheet-drops">
          <button
            type="button"
            class={['sell-sheet-drop', 'is-file', { 'is-over': dragOver() }]}
            disabled={Boolean(busy())}
            onClick={() => fileInput?.click()}
            onDragEnter={(event) => { event.preventDefault(); setDragOver(true); }}
            onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
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
            class="sell-sheet-drop is-paste"
            disabled={Boolean(busy())}
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
          ref={(el) => { fileInput = el; }}
          type="file"
          accept={SPREADSHEET_ACCEPT}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            onFile(file);
          }}
        />
        <Show when={note()}><p class="sell-sheet-note" role="status">{note()}</p></Show>
        <Show when={sheet()?.cardtraderLinks}>
          <div class="sell-sheet-ct" role="group" aria-labelledby="ct-link-title">
            <h3 id="ct-link-title">CardTrader links in this file</h3>
            <p>Link the current Pokoin cards to those CardTrader listings, or import the cards from CardTrader.</p>
            <p class="sell-sheet-warn">If a card is already on both Pokoin and CardTrader, linking or importing can create duplicates.</p>
            <div class="sell-sheet-confirm">
              <button type="button" class={ctIntent() === 'link' ? 'btn' : 'btn ghost'} onClick={() => setCtIntent('link')}>Link to CardTrader</button>
              <button type="button" class={ctIntent() === 'import' ? 'btn' : 'btn ghost'} onClick={() => setCtIntent('import')}>Import from CardTrader</button>
            </div>
          </div>
        </Show>
        <Show when={sheet()}>
          <div class="sell-sheet-confirm">
            <button
              type="button"
              class="btn"
              disabled={Boolean(busy()) || (sheet().cardtraderLinks && !ctIntent())}
              onClick={confirmPending}
            >
              {busy() === 'list' ? 'Listing…' : `List ${sheet().rows.length.toLocaleString('en-US')} cards`}
            </button>
            <button type="button" class="btn ghost" disabled={Boolean(busy())} onClick={() => setSheet(null)}>Dismiss</button>
          </div>
        </Show>
      </DeskPanel>

      <Show when={sheet()}>
        <DeskPanel title={`${FORMAT_LABEL[sheet().format]} · ${sheet().rows.length.toLocaleString('en-US')} cards`}>
          <div class="sell-sheet-table-wrap">
            <table class="sell-sheet-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Set</th>
                  <th scope="col">Number</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Condition</th>
                  <th scope="col">Language</th>
                  <th scope="col">Price</th>
                  <Show when={sheet().hasLocation}><th scope="col">Location</th></Show>
                </tr>
              </thead>
              <tbody>
                <For each={visibleCards()}>
                  {(card) => (
                    <tr>
                      <td>{card.name}</td>
                      <td>{card.setName}</td>
                      <td>{card.number}</td>
                      <td>{card.quantity}</td>
                      <td>{card.condition}</td>
                      <td>{card.language}</td>
                      <td>{card.price}</td>
                      <Show when={sheet().hasLocation}><td>{card.location}</td></Show>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
          <Show when={pageCount() > 1}>
            <div class="sell-sheet-pager">
              <button type="button" class="btn ghost" disabled={page() === 0} onClick={() => turnPage(-1)}>Previous</button>
              <span>
                {start() + 1}
                –
                {Math.min(start() + SPREADSHEET_PAGE, sheet().rows.length)}
                {' of '}
                {sheet().rows.length.toLocaleString('en-US')}
              </span>
              <button type="button" class="btn ghost" disabled={page() + 1 >= pageCount()} onClick={() => turnPage(1)}>Next</button>
            </div>
          </Show>
        </DeskPanel>
      </Show>

      <DeskPanel title="Recent imports">
        <div class="sell-sheet-table-wrap">
          <table class="sell-sheet-table">
            <thead>
              <tr>
                <For each={IMPORT_COLUMNS}>{([, label]) => <th scope="col">{label}</th>}</For>
              </tr>
            </thead>
            <tbody>
              <Show when={!saved().length}>
                <tr>
                  <td class="sell-sheet-empty" colSpan={IMPORT_COLUMNS.length}>
                    No imports yet. Your spreadsheet imports show up here.
                  </td>
                </tr>
              </Show>
              <For each={saved()}>
                {(row) => (
                  <tr>
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
                    <td>{statusLabel(row, busy())}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </DeskPanel>

      <Show when={pasteOpen()}>
        <div class="sell-sheet-modal" role="presentation" onClick={() => setPasteOpen(false)}>
          <form
            class="sell-sheet-dialog"
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
              ref={(el) => queueMicrotask(() => el.focus())}
              value={pasteText()}
              onInput={(event) => setPasteText(event.target.value)}
              placeholder="Paste CSV or spreadsheet rows"
            />
            <div class="sell-sheet-dialog-actions">
              <button type="button" class="btn ghost" onClick={() => setPasteOpen(false)}>Cancel</button>
              <button type="submit" class="btn" disabled={Boolean(busy()) || !pasteText().trim()}>
                {busy() === 'read' ? 'Reading…' : 'Import'}
              </button>
            </div>
          </form>
        </div>
      </Show>
    </div>
  );
}

/** /mypokoin/spreadsheet (market/src/pages/SellSpreadsheet.jsx). Dev `?sheetPreview` skips the sign-in gate. */
export default function SellSpreadsheet() {
  const location = useLocation();
  document.title = 'Sell via spreadsheet · Pokoin';
  if (allowLayoutPreview(untrack(() => location.search))) return <SpreadsheetDesk />;
  return (
    <SignedIn from="/mypokoin/spreadsheet">
      <SpreadsheetDesk />
    </SignedIn>
  );
}
