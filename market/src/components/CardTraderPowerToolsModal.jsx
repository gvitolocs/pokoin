import { useEffect, useMemo, useState } from 'react';
import { GAMES } from '../game.js';

const GAME_LABEL = Object.fromEntries(
  Object.values(GAMES).map((game) => [game.id, game.name]),
);

/**
 * After Sync: ask Power Tools? → upload CSV per TCG from CardTrader export → run sync.
 */
export default function CardTraderPowerToolsModal({
  open,
  busy = false,
  games = null,
  loadingGames = false,
  onClose,
  onSkipPowerTools,
  onPreviewGames,
  onConfirmWithCsv,
}) {
  const [step, setStep] = useState('ask'); // ask | upload
  const [files, setFiles] = useState({});
  const [stackSize, setStackSize] = useState(1);
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    if (!open) {
      setStep('ask');
      setFiles({});
      setLocalError('');
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

  async function confirm() {
    setLocalError('');
    const uploaded = Object.keys(files).filter((id) => files[id]?.trim());
    if (!uploaded.length) {
      setLocalError('Upload at least one Power Tools CSV, or choose No.');
      return;
    }
    await onConfirmWithCsv?.({ powerToolsCsv: files, stackSize });
  }

  return (
    <div className="ct-pt-overlay" role="dialog" aria-modal="true" aria-labelledby="ct-pt-title">
      <div className="ct-pt-modal">
        <h2 id="ct-pt-title">Sync CardTrader</h2>
        {step === 'ask' ? (
          <>
            <p className="page-lede">
              Do you also use Power Tools for inventory? If yes, upload your Power Tools
              stock CSV per TCG so Pokoin listings get the same box / stack / position.
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
        ) : (
          <>
            <p className="page-lede">
              Upload a Power Tools CSV for each game in your CardTrader stock.
              The <code>location</code> column becomes your Pokoin inventory slot.
            </p>
            {loadingGames ? <p className="page-lede muted">Reading games from CardTrader…</p> : null}
            {!loadingGames && !gameRows.length ? (
              <p className="ct-connect-err">No supported TCG products in your CardTrader export.</p>
            ) : null}
            <label className="ct-pt-stack">
              Stack size
              <input
                type="number"
                min={1}
                max={100}
                value={stackSize}
                disabled={busy}
                onChange={(event) => setStackSize(Math.max(1, Number(event.target.value) || 1))}
              />
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
                        disabled={busy}
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
              <button type="button" className="btn btn-cardtrader" disabled={busy || loadingGames} onClick={confirm}>
                {busy ? 'Starting…' : 'Sync with Power Tools'}
              </button>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => setStep('ask')}>
                Back
              </button>
              <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
