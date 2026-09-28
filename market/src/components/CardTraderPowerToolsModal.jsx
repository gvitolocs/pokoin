import { useEffect, useMemo, useState } from 'react';
import { GAMES } from '../game.js';

const GAME_LABEL = Object.fromEntries(
  Object.values(GAMES).map((game) => [game.id, game.name]),
);

const LOCATION_MODES = [
  {
    id: 'as_is',
    label: 'Location is the box name',
    hint: 'Keep each CSV location as written (whole Power Tools box label).',
  },
  {
    id: 'trailing_stack',
    label: 'Last number is the stack index',
    hint: 'The trailing number is which divider, not how many cards are in it.',
  },
  {
    id: 'structured',
    label: 'Already box·stack',
    hint: 'CSV already uses Pokoin-style box·stack (or box·stack·pos).',
  },
];

/**
 * After Sync: ask Power Tools? → upload CSV per TCG → analyze → confirm mapping from their data.
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
  const [stackSize, setStackSize] = useState(0); // 0 = use suggested after analyze
  const [numberedInStack, setNumberedInStack] = useState(false);
  const [locationParse, setLocationParse] = useState('auto');
  const [localError, setLocalError] = useState('');
  const [stackSizeTouched, setStackSizeTouched] = useState(false);
  const [locationTouched, setLocationTouched] = useState(false);

  useEffect(() => {
    if (!open) {
      setStep('ask');
      setFiles({});
      setLocalError('');
      setNumberedInStack(false);
      setLocationParse('auto');
      setStackSize(0);
      setStackSizeTouched(false);
      setLocationTouched(false);
    }
  }, [open]);

  // After analyze, adopt what the CSV actually contains unless the seller already chose.
  useEffect(() => {
    if (step !== 'preview' || !preview?.ok) return;
    if (!locationTouched && preview.locationParse) {
      setLocationParse(preview.locationParse);
    }
    const suggested = Number(preview.suggestedStackSize) || 0;
    if (!stackSizeTouched && suggested > 0) {
      setStackSize(suggested);
    }
  }, [preview, step, locationTouched, stackSizeTouched]);

  useEffect(() => {
    if (open && step === 'upload' && !games && !loadingGames) {
      onPreviewGames?.();
    }
  }, [open, step, games, loadingGames, onPreviewGames]);

  const gameRows = useMemo(() => {
    if (Array.isArray(games) && games.length) return games;
    return [];
  }, [games]);

  const examples = preview?.locationExamples || preview?.locationDetection?.locationExamples || [];
  const exampleHint = examples[0] || '';

  const syncOptions = useMemo(() => ({
    powerToolsCsv: files,
    stackSize: stackSize > 0 ? stackSize : undefined,
    numberedInStack,
    locationParse: locationParse === 'auto' ? 'auto' : locationParse,
  }), [files, stackSize, numberedInStack, locationParse]);

  const visibleOverflows = useMemo(() => {
    const capacity = stackSize > 0 ? stackSize : Number(preview?.suggestedStackSize) || 0;
    const rows = preview?.overflows || [];
    if (!capacity) return [];
    return rows.filter((row) => Number(row.count) > capacity);
  }, [preview, stackSize]);

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

  async function runAnalyze(options = syncOptions) {
    setLocalError('');
    if (!uploadedIds().length) {
      setLocalError('Upload at least one Power Tools CSV, or choose No.');
      return false;
    }
    const ok = await onPreviewSample?.(options);
    if (ok !== false) setStep('preview');
    return ok !== false;
  }

  async function reAnalyzeWith(next) {
    setLocalError('');
    await onPreviewSample?.({
      ...syncOptions,
      ...next,
    });
  }

  async function confirmFull() {
    setLocalError('');
    const capacity = stackSize > 0 ? stackSize : Number(preview?.suggestedStackSize) || 1;
    const parse = locationParse === 'auto'
      ? (preview?.locationParse || 'as_is')
      : locationParse;
    await onConfirmWithCsv?.({
      ...syncOptions,
      stackSize: capacity,
      locationParse: parse,
    });
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
              Upload a Power Tools CSV for each game you keep in Power Tools. We will read the
              location column from your file next — nothing is guessed before that.
            </p>
            {loadingGames ? <p className="page-lede muted">Reading games from CardTrader…</p> : null}
            {!loadingGames && !gameRows.length ? (
              <p className="ct-connect-err">No supported TCG products in your CardTrader export.</p>
            ) : null}

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
                disabled={busy || previewBusy || loadingGames || !uploadedIds().length}
                onClick={() => runAnalyze({
                  powerToolsCsv: files,
                  locationParse: 'auto',
                  numberedInStack: false,
                })}
              >
                {previewBusy ? 'Reading CSV…' : 'Analyze CSV'}
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
              From your CSV
              {preview?.totalPowerToolsRows ? ` (${preview.totalPowerToolsRows} rows)` : ''}, we found how
              locations are written. Confirm the mapping before the full import.
            </p>

            {examples.length ? (
              <div className="ct-pt-suggest">
                <p className="page-lede">
                  Location samples from your file:{' '}
                  {examples.slice(0, 3).map((ex, i) => (
                    <span key={ex}>
                      {i ? ', ' : ''}
                      <code>{ex}</code>
                    </span>
                  ))}
                </p>
              </div>
            ) : (
              <p className="page-lede muted">No location values found in the uploaded CSV.</p>
            )}

            <fieldset className="ct-pt-fieldset">
              <legend>How should we read those locations?</legend>
              {LOCATION_MODES.map((mode) => (
                <label key={mode.id} className="ct-pt-radio">
                  <input
                    type="radio"
                    name="ct-pt-location-parse"
                    checked={locationParse === mode.id}
                    disabled={busy || previewBusy}
                    onChange={() => {
                      setLocationTouched(true);
                      setLocationParse(mode.id);
                      reAnalyzeWith({ locationParse: mode.id });
                    }}
                  />
                  <span>
                    <strong>{mode.label}</strong>
                    <span className="page-lede muted">
                      {' '}— {mode.hint}
                      {mode.id === 'trailing_stack' && exampleHint ? (
                        <>
                          {' '}Your file: <code>{exampleHint}</code>
                        </>
                      ) : null}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            <label className="ct-pt-stack">
              Cards per stack (capacity)
              <input
                type="number"
                min={1}
                max={500}
                value={stackSize > 0 ? stackSize : (preview?.suggestedStackSize || '')}
                disabled={busy || previewBusy}
                onChange={(event) => {
                  setStackSizeTouched(true);
                  const next = Math.max(1, Number(event.target.value) || 1);
                  setStackSize(next);
                  reAnalyzeWith({ stackSize: next });
                }}
              />
            </label>
            {preview?.suggestedStackSize ? (
              <p className="page-lede muted">
                Fullest stack in your CSV has <strong>{preview.suggestedStackSize}</strong> cards
                {preview.occupancy?.[0]?.label ? (
                  <>
                    {' '}
                    (<code>{preview.occupancy[0].label}</code>)
                  </>
                ) : null}
                . That is the proposed capacity — not a stack index from the location string.
              </p>
            ) : null}

            <label className="ct-pt-check">
              <input
                type="checkbox"
                checked={numberedInStack}
                disabled={busy || previewBusy}
                onChange={(event) => {
                  const next = event.target.checked;
                  setNumberedInStack(next);
                  reAnalyzeWith({ numberedInStack: next });
                }}
              />
              <span>
                Numbered cards in stack
                <span className="page-lede muted">
                  {' '}— off by default. On = add ·pos inside each stack.
                </span>
              </span>
            </label>

            {visibleOverflows.length ? (
              <div className="ct-pt-warn">
                <strong>Over capacity</strong>
                <ul>
                  {visibleOverflows.slice(0, 8).map((row) => (
                    <li key={`${row.game}:${row.box}:${row.stack}`}>
                      {GAME_LABEL[row.game] || row.game}:{' '}
                      {row.count} cards in this stack (capacity {stackSize || preview?.suggestedStackSize})
                      {row.box ? (
                        <>
                          {' '}
                          — <code>{row.label || `${row.box}·${row.stack}`}</code>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="ct-connect-ok">
                No stack is over the capacity of {stackSize || preview?.suggestedStackSize || '—'} cards.
              </p>
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
                disabled={busy || previewBusy || !preview?.samples?.length}
                onClick={confirmFull}
              >
                {busy ? 'Starting…' : 'Looks good — full import'}
              </button>
              <button type="button" className="btn ghost" disabled={busy || previewBusy} onClick={() => setStep('upload')}>
                Change CSV
              </button>
              <button type="button" className="btn ghost" disabled={busy || previewBusy} onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
