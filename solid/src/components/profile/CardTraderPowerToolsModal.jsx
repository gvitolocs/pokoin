import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import { GAMES } from '@market/game.js';

const GAME_LABEL = Object.fromEntries(Object.values(GAMES).map((game) => [game.id, game.name]));

const LOCATION_MODES = [
  { id: 'as_is', label: 'Location is the box name', hint: 'Keep each CSV location as written (whole Power Tools box label).' },
  { id: 'trailing_stack', label: 'Last number is the stack index', hint: 'The trailing number is which divider, not how many cards are in it.' },
  { id: 'structured', label: 'Already box·stack', hint: 'CSV already uses Pokoin-style box·stack (or box·stack·pos).' },
];

/**
 * After Sync (market/src/components/CardTraderPowerToolsModal.jsx): ask Power
 * Tools? → upload CSV per TCG → analyze → confirm mapping from their data.
 */
export default function CardTraderPowerToolsModal(props) {
  const [step, setStep] = createSignal('ask'); // ask | upload | preview
  const [files, setFiles] = createSignal({});
  const [stackSize, setStackSize] = createSignal(0); // 0 = use suggested after analyze
  const [numberedInStack, setNumberedInStack] = createSignal(false);
  const [locationParse, setLocationParse] = createSignal('auto');
  const [localError, setLocalError] = createSignal('');
  const [stackSizeTouched, setStackSizeTouched] = createSignal(false);
  const [locationTouched, setLocationTouched] = createSignal(false);

  createEffect(() => Boolean(props.open), (open) => {
    if (open) return;
    setStep('ask');
    setFiles({});
    setLocalError('');
    setNumberedInStack(false);
    setLocationParse('auto');
    setStackSize(0);
    setStackSizeTouched(false);
    setLocationTouched(false);
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
  const examples = () => props.preview?.locationExamples || props.preview?.locationDetection?.locationExamples || [];
  const exampleHint = () => examples()[0] || '';
  const busyAll = () => Boolean(props.busy) || Boolean(props.previewBusy);

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

  function chooseYes() {
    setLocalError('');
    setStep('upload');
    props.onPreviewGames?.();
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
    reader.onload = () => setFiles((prev) => ({ ...prev, [gameId]: String(reader.result || '') }));
    reader.onerror = () => setLocalError('Could not read that CSV.');
    reader.readAsText(file);
  }

  const uploadedIds = () => Object.keys(files()).filter((id) => files()[id]?.trim());

  async function runAnalyze(options = syncOptions()) {
    setLocalError('');
    if (!uploadedIds().length) {
      setLocalError('Upload at least one Power Tools CSV, or choose No.');
      return false;
    }
    const ok = await props.onPreviewSample?.(options);
    if (ok !== false) setStep('preview');
    return ok !== false;
  }

  async function reAnalyzeWith(next) {
    setLocalError('');
    await props.onPreviewSample?.({ ...syncOptions(), ...next });
  }

  async function confirmFull() {
    setLocalError('');
    const capacity = stackSize() > 0 ? stackSize() : Number(props.preview?.suggestedStackSize) || 1;
    const parse = locationParse() === 'auto' ? (props.preview?.locationParse || 'as_is') : locationParse();
    await props.onConfirmWithCsv?.({ ...syncOptions(), stackSize: capacity, locationParse: parse });
  }

  const close = () => props.onClose?.();

  return (
    <Show when={props.open}>
      <div class="ct-pt-overlay" role="dialog" aria-modal="true" aria-labelledby="ct-pt-title">
        <div class="ct-pt-modal">
          <h2 id="ct-pt-title">Sync CardTrader</h2>
          <Switch>
            <Match when={step() === 'ask'}>
              <p class="page-lede">
                Do you also use Power Tools for inventory? If yes, upload your Power Tools
                stock CSV per TCG so Pokoin listings get the same box and stack.
              </p>
              <div class="ct-connect-actions">
                <button type="button" class="btn btn-cardtrader" disabled={props.busy} onClick={chooseYes}>Yes — I use Power Tools</button>
                <button type="button" class="btn" disabled={props.busy} onClick={() => props.onSkipPowerTools?.()}>No — sync CardTrader only</button>
                <button type="button" class="btn ghost" disabled={props.busy} onClick={close}>Cancel</button>
              </div>
            </Match>

            <Match when={step() === 'upload'}>
              <p class="page-lede">
                Upload a Power Tools CSV for each game you keep in Power Tools. We will read the
                location column from your file next — nothing is guessed before that.
              </p>
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
                            onChange={(event) => onFile(row.id, event.target.files?.[0] || null)}
                          />
                        </label>
                        <Show when={hasFile()}><span class="ct-connect-ok">CSV ready</span></Show>
                      </li>
                    );
                  }}
                </For>
              </ul>
              <Show when={localError()}><p class="ct-connect-err">{localError()}</p></Show>
              <div class="ct-connect-actions">
                <button
                  type="button"
                  class="btn btn-cardtrader"
                  disabled={busyAll() || props.loadingGames || !uploadedIds().length}
                  onClick={() => runAnalyze({ powerToolsCsv: files(), locationParse: 'auto', numberedInStack: false })}
                >
                  {props.previewBusy ? 'Reading CSV…' : 'Analyze CSV'}
                </button>
                <button type="button" class="btn ghost" disabled={busyAll()} onClick={() => setStep('ask')}>Back</button>
                <button type="button" class="btn ghost" disabled={busyAll()} onClick={close}>Cancel</button>
              </div>
            </Match>

            <Match when={step() === 'preview'}>
              <p class="page-lede">
                From your CSV
                {props.preview?.totalPowerToolsRows ? ` (${props.preview.totalPowerToolsRows} rows)` : ''}, we found how
                locations are written. Confirm the mapping before the full import.
              </p>

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
              <Show when={!props.preview?.samples?.length}>
                <p class="ct-connect-err">No sample rows — check the CSV and try again.</p>
              </Show>
              <Show when={localError()}><p class="ct-connect-err">{localError()}</p></Show>
              <div class="ct-connect-actions">
                <button type="button" class="btn btn-cardtrader" disabled={busyAll() || !props.preview?.samples?.length} onClick={confirmFull}>
                  {props.busy ? 'Starting…' : 'Looks good — full import'}
                </button>
                <button type="button" class="btn ghost" disabled={busyAll()} onClick={() => setStep('upload')}>Change CSV</button>
                <button type="button" class="btn ghost" disabled={busyAll()} onClick={close}>Cancel</button>
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </Show>
  );
}
