import { useEffect, useMemo, useState } from 'react';
import { GAMES } from '../game.js';

const GAME_LABEL = Object.fromEntries(
  Object.values(GAMES).map((game) => [game.id, game.name]),
);

const LOCATION_MODES = [
  {
    id: 'as_is',
    label: 'Location is the box name',
    hint: 'Keep the CSV location as written (Power Tools box label).',
  },
  {
    id: 'trailing_stack',
    label: 'Last number is the stack',
    hint: 'e.g. FUOCOBOMBA 006 - 16 → box “FUOCOBOMBA 006”, stack 16.',
  },
  {
    id: 'structured',
    label: 'Already box·stack',
    hint: 'CSV already uses Pokoin-style box·stack (or box·stack·pos).',
  },
];

/**
 * After Sync: ask Power Tools? → upload CSV per TCG → map box/stack → preview 3 → full import.
 */
export default function CardTraderPowerToolsModal({
  open,
  busy = false,
  games = null,
  loadingGames = false,
  previewBusy = false,
  preview = null,
  onClose,
  onSkipPowerTools,
  onPreviewGames,
  onPreviewSample,
  onConfirmWithCsv,
}) {
  const [step, setStep] = useState('ask'); // ask | upload | preview
  const [files, setFiles] = useState({});
  const [stackSize, setStackSize] = useState(60);
  const [numberedInStack, setNumberedInStack] = useState(false);
  const [locationParse, setLocationParse] = useState('trailing_stack');
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    if (!open) {
      setStep('ask');
      setFiles({});
      setLocalError('');
      setNumberedInStack(false);
      setLocationParse('trailing_stack');
      setStackSize(60);
    }
  }, [open]);

  useEffect(() => {
    if (open && step === 'upload' && !games && !loadingGames) {
      onPreviewGames?.();
    }
  }, [open, step, games, loadingGames, onPreviewGames]);

  const gameRows = useMemo(() => {
    if (Array.isArray(games) && games.length) return games;
    return [];
  }, [games]);

  const syncOptions = useMemo(() => ({
    powerToolsCsv: files,
    stackSize,
    numberedInStack,
    locationParse,
  }), [files, stackSize, numberedInStack, locationParse]);

  if (!open) return null;

  async function chooseYes() {
    setLocalError('');
    setStep('upload');
    onPreviewGames?.();
  }

  function onFile(gameId, file) {
    if (!file) {
      setFiles((prev) => {
        const next = { ...prev };
        delete next[gameId];
        return next;
      });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setFiles((prev) => ({ ...prev, [gameId]: String(reader.result || '') }));
    };
    reader.onerror = () => setLocalError('Could not read that CSV.');
    reader.readAsText(file);
  }

  function uploadedIds() {
    return Object.keys(files).filter((id) => files[id]?.trim());
  }

  async function runPreview() {
    setLocalError('');
    if (!uploadedIds().length) {
      setLocalError('Upload at least one Power Tools CSV, or choose No.');
      return;
    }
    const ok = await onPreviewSample?.(syncOptions);
    if (ok !== false) setStep('preview');
  }

  async function confirmFull() {
    setLocalError('');
    await onConfirmWithCsv?.(syncOptions);
  }

  return (
    <div className="ct-pt-overlay" role="dialog" aria-modal="true" aria-labelledby="ct-pt-title">
      <div className="ct-pt-modal">
        <h2 id="ct-pt-title">Sync CardTrader</h2>
        {step === 'ask' ? (
          <>
            <p className="page-lede">
              Do you also use Power Tools for inventory? If yes, upload your Power Tools
              stock CSV per TCG so Pokoin listings get the same box and stack.
            </p>
            <div className="ct-connect-actions">
              <button type="button" className="btn btn-cardtrader" disabled={busy} onClick={chooseYes}>
                Yes — I use Power Tools
              </button>
              <button type="button" className="btn" disabled={busy} onClick={onSkipPowerTools}>
                No — sync CardTrader only
              </button>
              <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        ) : null}

        {step === 'upload' ? (
          <>
            <p className="page-lede">
              Upload a Power Tools CSV for each game. Map how the location column becomes
              box / stack — we do not invent card numbers inside a stack unless you opt in.
            </p>
            {loadingGames ? <p className="page-lede muted">Reading games from CardTrader…</p> : null}
            {!loadingGames && !gameRows.length ? (
              <p className="ct-connect-err">No supported TCG products in your CardTrader export.</p>
            ) : null}

            <fieldset className="ct-pt-fieldset">
              <legend>Location numbers</legend>
              {LOCATION_MODES.map((mode) => (
                <label key={mode.id} className="ct-pt-radio">
                  <input
                    type="radio"
                    name="ct-pt-location-parse"
                    checked={locationParse === mode.id}
                    disabled={busy || previewBusy}
                    onChange={() => setLocationParse(mode.id)}
                  />
                  <span>
                    <strong>{mode.label}</strong>
                    <span className="page-lede muted"> — {mode.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <label className="ct-pt-stack">
              Cards per stack
              <input
                type="number"
                min={1}
                max={500}
                value={stackSize}
                disabled={busy || previewBusy}
                onChange={(event) => setStackSize(Math.max(1, Number(event.target.value) || 1))}
              />
            </label>
            <p className="page-lede muted">
              Used to warn when a box/stack has more cards than this capacity
              {numberedInStack ? ', and to number cards inside the stack' : ''}.
            </p>

            <label className="ct-pt-check">
              <input
                type="checkbox"
                checked={numberedInStack}
                disabled={busy || previewBusy}
                onChange={(event) => setNumberedInStack(event.target.checked)}
              />
              <span>
                Numbered cards in stack
                <span className="page-lede muted">
                  {' '}— off by default (Power Tools is usually box + stack only). On = add ·pos.
                </span>
              </span>
            </label>

            <ul className="ct-pt-games">
              {gameRows.map((row) => {
                const label = GAME_LABEL[row.id] || row.id;
                const hasFile = Boolean(files[row.id]?.trim());
                return (
                  <li key={row.id}>
                    <div>
                      <strong>{label}</strong>
                      <span className="page-lede muted"> · {row.count} on CardTrader</span>
                    </div>
                    <label className="ct-pt-file">
                      <span className="btn ghost">{hasFile ? 'Replace CSV' : 'Upload CSV'}</span>
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        hidden
                        disabled={busy || previewBusy}
                        onChange={(event) => onFile(row.id, event.target.files?.[0] || null)}
                      />
                    </label>
                    {hasFile ? <span className="ct-connect-ok">CSV ready</span> : null}
                  </li>
                );
              })}
            </ul>
            {localError ? <p className="ct-connect-err">{localError}</p> : null}
            <div className="ct-connect-actions">
              <button
                type="button"
                className="btn btn-cardtrader"
                disabled={busy || previewBusy || loadingGames}
                onClick={runPreview}
              >
                {previewBusy ? 'Checking…' : 'Preview 3 cards'}
              </button>
              <button type="button" className="btn ghost" disabled={busy || previewBusy} onClick={() => setStep('ask')}>
                Back
              </button>
              <button type="button" className="btn ghost" disabled={busy || previewBusy} onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        ) : null}

        {step === 'preview' ? (
          <>
            <p className="page-lede">
              Sample of how Power Tools locations map onto Pokoin. Confirm before the full
              CardTrader + Power Tools import.
            </p>
            {preview?.overflows?.length ? (
              <div className="ct-pt-warn">
                <strong>Stack overflow</strong>
                <ul>
                  {preview.overflows.slice(0, 8).map((row) => (
                    <li key={`${row.game}:${row.box}:${row.stack}`}>
                      {GAME_LABEL[row.game] || row.game}: {row.message || `${row.count} &gt; ${row.stackSize}`}
                    </li>
                  ))}
                </ul>
                <p className="page-lede muted">Raise “Cards per stack” or split that box before importing.</p>
              </div>
            ) : (
              <p className="ct-connect-ok">No stack overflows for size {stackSize}.</p>
            )}
            <ul className="ct-pt-samples">
              {(preview?.samples || []).map((row, index) => (
                <li key={`${row.name}:${index}`}>
                  <strong>{row.name || 'Card'}</strong>
                  <span className="thread-meta">
                    {row.condition} {row.language}
                    {row.reverse ? ' · reverse' : ''}
                    {row.matched ? ' · matched on CardTrader' : ' · CSV only'}
                  </span>
                  <span className="ct-pt-loc">
                    {row.sourceLocation || '—'}
                    {' → '}
                    <code>{row.location || '—'}</code>
                  </span>
                </li>
              ))}
            </ul>
            {!preview?.samples?.length ? (
              <p className="ct-connect-err">No sample rows — check the CSV and try again.</p>
            ) : null}
            {localError ? <p className="ct-connect-err">{localError}</p> : null}
            <div className="ct-connect-actions">
              <button
                type="button"
                className="btn btn-cardtrader"
                disabled={busy || !preview?.samples?.length}
                onClick={confirmFull}
              >
                {busy ? 'Starting…' : 'Looks good — full import'}
              </button>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => setStep('upload')}>
                Adjust settings
              </button>
              <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
