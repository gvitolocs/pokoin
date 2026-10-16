import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import { GAMES } from '@market/game.js';

const GAME_LABEL = Object.fromEntries(Object.values(GAMES).map((game) => [game.id, game.name]));

const UNRESOLVED_REASON = {
  unknown_cardmarket_id: 'No catalog match for this Cardmarket id',
  ambiguous_game: 'This Cardmarket id exists in more than one game catalog',
  ambiguous_set_name: 'This set name exists in more than one game catalog',
};

const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;

const LOCATION_MODES = [
  { id: 'as_is', label: 'Location is the box name', hint: 'Keep each CSV location as written (whole Power Tools box label).' },
  { id: 'trailing_stack', label: 'Last number is the stack index', hint: 'The trailing number is which divider, not how many cards are in it.' },
  { id: 'structured', label: 'Already box·stack', hint: 'CSV already uses Pokoin-style box·stack (or box·stack·pos).' },
];

/**
 * Import locations: upload a Power Tools CSV per TCG → analyze → confirm the
 * mapping from their data → sync, which puts each matched CardTrader
 * listing's box and stack on its Pokoin listing.
 */
export default function CardTraderPowerToolsModal(props) {
  const [step, setStep] = createSignal('upload'); // upload | preview
  const [uploadMode, setUploadMode] = createSignal('all'); // all | per-game
  const [files, setFiles] = createSignal({});
  const [fileNames, setFileNames] = createSignal({});
  const [analyzeToken, setAnalyzeToken] = createSignal(0);
  const [stackSize, setStackSize] = createSignal(0); // 0 = use suggested after analyze
  const [numberedInStack, setNumberedInStack] = createSignal(false);
  const [locationParse, setLocationParse] = createSignal('auto');
  const [localError, setLocalError] = createSignal('');
  const [stackSizeTouched, setStackSizeTouched] = createSignal(false);
  const [locationTouched, setLocationTouched] = createSignal(false);

  function clearPreview() {
    props.onClearPreview?.();
  }

  function invalidateUploadState() {
    clearPreview();
    setStep('upload');
    setAnalyzeToken((n) => n + 1);
  }

  createEffect(() => Boolean(props.open), (open) => {
    if (open) return;
    setStep('upload');
    setUploadMode('all');
    setFiles({});
    setFileNames({});
    setLocalError('');
    setNumberedInStack(false);
    setLocationParse('auto');
    setStackSize(0);
    setStackSizeTouched(false);
    setLocationTouched(false);
    setAnalyzeToken(0);
    clearPreview();
  });

  // After analyze, adopt what the CSV actually contains unless the seller already chose.
  createEffect(
    () => (step() === 'preview' && props.preview?.ok ? props.preview : null),
    (preview) => {
      if (!preview) return;
      if (!locationTouched() && preview.locationParse) setLocationParse(preview.locationParse);
      const suggested = Number(preview.suggestedStackSize) || 0;
      if (!stackSizeTouched() && suggested > 0) setStackSize(suggested);
    },
  );

  createEffect(
    () => props.open && step() === 'upload' && !props.games && !props.loadingGames,
    (load) => {
      if (load) props.onPreviewGames?.();
    },
  );

  const gameRows = () => (Array.isArray(props.games) && props.games.length ? props.games : []);
  const gameDetection = () => props.preview?.gameDetection || null;
  const examples = () => props.preview?.locationExamples || props.preview?.locationDetection?.locationExamples || [];
  const exampleHint = () => examples()[0] || '';
  const busyAll = () => Boolean(props.busy) || Boolean(props.previewBusy);
  const unresolvedCount = () => Number(gameDetection()?.unresolvedCount) || 0;
  const recognizedRowCount = () => {
    const games = gameDetection()?.games;
    if (!Array.isArray(games)) return null;
    return games.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
  };

  const syncOptions = createMemo(() => ({
    powerToolsCsv: files(),
    stackSize: stackSize() > 0 ? stackSize() : undefined,
    numberedInStack: numberedInStack(),
    locationParse: locationParse() === 'auto' ? 'auto' : locationParse(),
  }));

  const visibleOverflows = () => {
    const capacity = stackSize() > 0 ? stackSize() : Number(props.preview?.suggestedStackSize) || 0;
    const rows = props.preview?.overflows || [];
    if (!capacity) return [];
    return rows.filter((row) => Number(row.count) > capacity);
  };

  function setMode(next) {
    if (next === uploadMode()) return;
    setUploadMode(next);
    setFiles({});
    setFileNames({});
    invalidateUploadState();
  }

  function onFile(gameId, file) {
    if (!file) {
      setFiles((prev) => {
        const next = { ...prev };
        delete next[gameId];
        return next;
      });
      setFileNames((prev) => {
        const next = { ...prev };
        delete next[gameId];
        return next;
      });
      invalidateUploadState();
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setFiles((prev) => ({ ...prev, [gameId]: String(reader.result || '') }));
      setFileNames((prev) => ({ ...prev, [gameId]: file.name || 'upload.csv' }));
      invalidateUploadState();
    };
    reader.onerror = () => setLocalError('Could not read that CSV.');
    reader.readAsText(file);
  }

  const uploadedIds = () => Object.keys(files()).filter((id) => files()[id]?.trim());

  async function runAnalyze(options = syncOptions()) {
    setLocalError('');
    if (!uploadedIds().length) {
      setLocalError(uploadMode() === 'all' ? 'Upload your all-games Power Tools CSV.' : 'Upload at least one Power Tools CSV.');
      return false;
    }
    const token = analyzeToken() + 1;
    setAnalyzeToken(token);
    const ok = await props.onPreviewSample?.(options);
    if (analyzeToken() !== token) return false;
    if (ok !== false) setStep('preview');
    return ok !== false;
  }

  async function reAnalyzeWith(next) {
    setLocalError('');
    const token = analyzeToken() + 1;
    setAnalyzeToken(token);
    await props.onPreviewSample?.({ ...syncOptions(), ...next });
    if (analyzeToken() !== token) return;
  }

  async function confirmFull() {
    setLocalError('');
    const capacity = stackSize() > 0 ? stackSize() : Number(props.preview?.suggestedStackSize) || 1;
    const parse = locationParse() === 'auto' ? (props.preview?.locationParse || 'as_is') : locationParse();
    const payload = { ...syncOptions(), stackSize: capacity, locationParse: parse };
    if (unresolvedCount() > 0) payload.powerToolsRecognizedOnly = true;
    await props.onConfirmWithCsv?.(payload);
  }

  const close = () => props.onClose?.();

  const canImport = () => {
    if (!props.preview?.samples?.length && !recognizedRowCount()) return false;
    if (unresolvedCount() > 0) return recognizedRowCount() > 0;
    return Boolean(props.preview?.samples?.length);
  };

  return (
    <Show when={props.open}>
      <div class="ct-pt-overlay" role="dialog" aria-modal="true" aria-labelledby="ct-pt-title">
        <div class="ct-pt-modal">
          <h2 id="ct-pt-title">Import locations from Power Tools</h2>
          <Switch>
            <Match when={step() === 'upload'}>
              <p class="page-lede">
                Upload your Power Tools stock export (one file for all games, or separate CSVs per TCG).
                Each card that matches your CardTrader stock gets the same box and stack on Pokoin.
                We read the location column from your file — nothing is guessed before you analyze.
              </p>

              <fieldset class="ct-pt-fieldset">
                <legend>CSV upload</legend>
                <label class="ct-pt-radio">
                  <input
                    type="radio"
                    name="ct-pt-upload-mode"
                    checked={uploadMode() === 'all'}
                    disabled={busyAll()}
                    onChange={() => setMode('all')}
                  />
                  <span>
                    <strong>One all-games file</strong>
                    <span class="page-lede muted"> — Power Tools export with every TCG in one CSV (no game column).</span>
                  </span>
                </label>
                <label class="ct-pt-radio">
                  <input
                    type="radio"
                    name="ct-pt-upload-mode"
                    checked={uploadMode() === 'per-game'}
                    disabled={busyAll()}
                    onChange={() => setMode('per-game')}
                  />
                  <span>
                    <strong>Separate file per game</strong>
                    <span class="page-lede muted"> — use when auto-detection cannot place some rows.</span>
                  </span>
                </label>
              </fieldset>

              <Show when={uploadMode() === 'all'}>
                <div class="ct-pt-all-upload">
                  <label class="ct-pt-file">
                    <span class="btn ghost">{files().auto?.trim() ? 'Replace CSV' : 'Choose all-games CSV'}</span>
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      hidden
                      disabled={busyAll()}
                      aria-label="Power Tools all-games stock CSV"
                      onChange={(event) => onFile('auto', event.target.files?.[0] || null)}
                    />
                  </label>
                  <Show when={fileNames().auto}>
                    <span class="ct-pt-filename" title={fileNames().auto}>{fileNames().auto}</span>
                    <button type="button" class="btn ghost" disabled={busyAll()} onClick={() => onFile('auto', null)}>
                      Remove
                    </button>
                  </Show>
                </div>
              </Show>

              <Show when={uploadMode() === 'per-game'}>
                <Show when={props.loadingGames}><p class="page-lede muted">Reading games from CardTrader…</p></Show>
                <Show when={!props.loadingGames && !gameRows().length}>
                  <p class="ct-connect-err">No supported TCG products in your CardTrader export.</p>
                </Show>
                <ul class="ct-pt-games">
                  <For each={gameRows()}>
                    {(row) => {
                      const hasFile = () => Boolean(files()[row.id]?.trim());
                      return (
                        <li>
                          <div>
                            <strong>{GAME_LABEL[row.id] || row.id}</strong>
                            <span class="page-lede muted"> · {row.count} on CardTrader</span>
                          </div>
                          <label class="ct-pt-file">
                            <span class="btn ghost">{hasFile() ? 'Replace CSV' : 'Upload CSV'}</span>
                            <input
                              type="file"
                              accept=".csv,text/csv"
                              hidden
                              disabled={busyAll()}
                              aria-label={`Power Tools CSV for ${GAME_LABEL[row.id] || row.id}`}
                              onChange={(event) => onFile(row.id, event.target.files?.[0] || null)}
                            />
                          </label>
                          <Show when={fileNames()[row.id]}>
                            <span class="ct-pt-filename">{fileNames()[row.id]}</span>
                          </Show>
                          <Show when={hasFile()}><span class="ct-connect-ok">CSV ready</span></Show>
                        </li>
                      );
                    }}
                  </For>
                </ul>
              </Show>

              <Show when={localError()}><p class="ct-connect-err">{localError()}</p></Show>
              <div class="ct-connect-actions">
                <button
                  type="button"
                  class="btn btn-cardtrader"
                  disabled={busyAll() || (uploadMode() === 'per-game' && props.loadingGames) || !uploadedIds().length}
                  onClick={() => runAnalyze({ powerToolsCsv: files(), locationParse: 'auto', numberedInStack: false })}
                >
                  {props.previewBusy ? 'Reading CSV…' : 'Analyze CSV'}
                </button>
                <button type="button" class="btn ghost" disabled={busyAll()} onClick={close}>Cancel</button>
              </div>
            </Match>

            <Match when={step() === 'preview'}>
              <p class="page-lede">
                From your CSV
                {props.preview?.totalPowerToolsRows ? ` (${props.preview.totalPowerToolsRows} rows with stock)` : ''}, we found how
                locations are written. Confirm the mapping before the import.
              </p>

              <Show when={gameDetection()}>
                <div class="ct-pt-suggest">
                  <p class="page-lede"><strong>Games detected</strong></p>
                  <ul class="ct-pt-games">
                    <For each={gameDetection().games || []}>
                      {(row) => (
                        <li>
                          <strong>{GAME_LABEL[row.id] || row.id}</strong>
                          <span class="page-lede muted">
                            {' '}{plural(row.count, 'row')} · {plural(row.quantity, 'unit')}
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                  <Show when={Number(gameDetection().skippedZeroRows) > 0}>
                    <p class="page-lede muted">
                      Skipped {gameDetection().skippedZeroRows} zero-quantity rows (not used for locations).
                    </p>
                  </Show>
                  <Show when={unresolvedCount() > 0}>
                    <div class="ct-pt-warn">
                      <strong>{unresolvedCount()} row{unresolvedCount() === 1 ? '' : 's'} could not be assigned to a game</strong>
                      <p class="page-lede muted">
                        They will not be imported unless you switch to per-game CSVs or import recognized rows only below.
                        <Show when={(gameDetection().unresolved || []).length < unresolvedCount()}>
                          {' '}Showing the first {(gameDetection().unresolved || []).length}.
                        </Show>
                      </p>
                      <ul>
                        <For each={gameDetection().unresolved || []}>
                          {(row) => (
                            <li>
                              Line {row.line}: <code>{row.cardmarketId || '—'}</code>
                              {row.name ? ` · ${row.name}` : ''}
                              {row.set ? ` · ${row.set}` : ''}
                              {' — '}
                              {UNRESOLVED_REASON[row.reason] || row.reason}
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                  </Show>
                </div>
              </Show>

              <Show when={examples().length} fallback={<p class="page-lede muted">No location values found in the uploaded CSV.</p>}>
                <div class="ct-pt-suggest">
                  <p class="page-lede">
                    Location samples from your file:{' '}
                    <For each={examples().slice(0, 3)}>
                      {(ex, i) => <span>{i() ? ', ' : ''}<code>{ex}</code></span>}
                    </For>
                  </p>
                </div>
              </Show>

              <fieldset class="ct-pt-fieldset">
                <legend>How should we read those locations?</legend>
                <For each={LOCATION_MODES}>
                  {(mode) => (
                    <label class="ct-pt-radio">
                      <input
                        type="radio"
                        name="ct-pt-location-parse"
                        checked={locationParse() === mode.id}
                        disabled={busyAll()}
                        onChange={() => {
                          setLocationTouched(true);
                          setLocationParse(mode.id);
                          reAnalyzeWith({ locationParse: mode.id });
                        }}
                      />
                      <span>
                        <strong>{mode.label}</strong>
                        <span class="page-lede muted">
                          {' '}— {mode.hint}
                          <Show when={mode.id === 'trailing_stack' && exampleHint()}>
                            {' '}Your file: <code>{exampleHint()}</code>
                          </Show>
                        </span>
                      </span>
                    </label>
                  )}
                </For>
              </fieldset>

              <label class="ct-pt-stack">
                Cards per stack (capacity)
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={stackSize() > 0 ? stackSize() : (props.preview?.suggestedStackSize || '')}
                  disabled={busyAll()}
                  onChange={(event) => {
                    setStackSizeTouched(true);
                    const next = Math.max(1, Number(event.target.value) || 1);
                    setStackSize(next);
                    reAnalyzeWith({ stackSize: next });
                  }}
                />
              </label>
              <Show when={props.preview?.suggestedStackSize}>
                <p class="page-lede muted">
                  Fullest stack in your CSV has <strong>{props.preview.suggestedStackSize}</strong> cards
                  <Show when={props.preview.occupancy?.[0]?.label}>
                    {' '}(<code>{props.preview.occupancy[0].label}</code>)
                  </Show>
                  . That is the proposed capacity — not a stack index from the location string.
                </p>
              </Show>

              <label class="ct-pt-check">
                <input
                  type="checkbox"
                  checked={numberedInStack()}
                  disabled={busyAll()}
                  onChange={(event) => {
                    const next = event.target.checked;
                    setNumberedInStack(next);
                    reAnalyzeWith({ numberedInStack: next });
                  }}
                />
                <span>
                  Numbered cards in stack
                  <span class="page-lede muted">{' '}— off by default. On = add ·pos inside each stack.</span>
                </span>
              </label>

              <Show
                when={visibleOverflows().length}
                fallback={<p class="ct-connect-ok">No stack is over the capacity of {stackSize() || props.preview?.suggestedStackSize || '—'} cards.</p>}
              >
                <div class="ct-pt-warn">
                  <strong>Over capacity</strong>
                  <ul>
                    <For each={visibleOverflows().slice(0, 8)}>
                      {(row) => (
                        <li>
                          {GAME_LABEL[row.game] || row.game}:{' '}
                          {row.count} cards in this stack (capacity {stackSize() || props.preview?.suggestedStackSize})
                          <Show when={row.box}>{' '}— <code>{row.label || `${row.box}·${row.stack}`}</code></Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>

              <ul class="ct-pt-samples">
                <For each={props.preview?.samples || []}>
                  {(row) => (
                    <li>
                      <Show when={row.game}>
                        <span class="thread-meta">{GAME_LABEL[row.game] || row.game}</span>
                      </Show>
                      <strong>{row.name || 'Card'}</strong>
                      <span class="thread-meta">
                        {row.condition} {row.language}
                        {row.reverse ? ' · reverse' : ''}
                        {row.matched ? ' · matched on CardTrader' : ' · CSV only'}
                      </span>
                      <span class="ct-pt-loc">
                        {row.sourceLocation || '—'}
                        {' → '}
                        <code>{row.location || '—'}</code>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={!props.preview?.samples?.length && !recognizedRowCount()}>
                <p class="ct-connect-err">No rows with stock — check the CSV and try again.</p>
              </Show>
              <Show when={localError()}><p class="ct-connect-err">{localError()}</p></Show>
              <div class="ct-connect-actions">
                <button type="button" class="btn btn-cardtrader" disabled={busyAll() || !canImport()} onClick={confirmFull}>
                  {props.busy
                    ? 'Starting…'
                    : unresolvedCount() > 0
                      ? `Import ${recognizedRowCount() || 0} recognized rows`
                      : 'Looks good — import locations'}
                </button>
                <button type="button" class="btn ghost" disabled={busyAll()} onClick={() => { setStep('upload'); clearPreview(); }}>
                  Change CSV
                </button>
                <button type="button" class="btn ghost" disabled={busyAll()} onClick={close}>Cancel</button>
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </Show>
  );
}
