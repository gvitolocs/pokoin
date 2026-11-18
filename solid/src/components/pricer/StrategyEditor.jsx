import { createMemo, createSignal, For, Show } from 'solid-js';
import {
  localizeStrategyName,
  localToPkn,
  nameProblem,
  pknToLocal,
  PRICER_ACTIONS,
  PRICER_MATCHES,
  PRICER_ROUNDINGS,
  sourceHasFees,
  sourceSwitches,
  switchNote,
} from '@market/pricer.js';
import { Alert } from '../Desk.jsx';
import {
  draftChanged,
  EDITOR_SOURCES,
  editorBasisGroups,
  editorSource,
  exampleLead,
  exampleSteps,
  NO_OFFER,
  pickExampleComp,
  pkn,
  SAMPLE_COMP,
  showsSwitches,
  strategyDraft,
  uniqueCopyName,
  usedByLine,
  withSource,
  withEditorBasis,
} from './pricer-ui.js';

const numberInput = (value) => (value === '' ? '' : Number(value));

/**
 * A money field in the seller's currency; the draft keeps PKN. While focused
 * the raw text stays put — a half-typed "0." must not round-trip through PKN.
 */
function MoneyInput(props) {
  const [text, setText] = createSignal(null);
  const local = () => String(Math.round(pknToLocal(props.value, props.ctx) * 100) / 100);
  return (
    <input
      type="number"
      inputMode="decimal"
      min="0"
      step="0.01"
      value={text() == null ? local() : text()}
      onFocus={() => setText(local())}
      onBlur={() => setText(null)}
      onInput={(event) => {
        setText(event.target.value);
        props.onValue(event.target.value === '' ? 0 : localToPkn(Number(event.target.value), props.ctx));
      }}
    />
  );
}

/**
 * The strategy editor's state: the draft, what it was opened as, and the
 * unsaved-changes gate. One set of signals for both places that show it —
 * Pricer → Strategies and the listing drawer's "New strategy" step — which
 * render it with `<StrategyEditor editor={…} />`.
 *
 * options: `strategy` the saved strategy to open (none: the new form),
 * `ctx` () => the currency context, `strategies` () => the saved ones,
 * `exampleComp` () => a comp for the worked example, `save(draft)` => the
 * saved id, `remove(id)`, `onBack()`.
 */
export function createStrategyEditor(options = {}) {
  const ctx = () => options.ctx();
  const stored = () => options.strategies() || [];
  const [selectedId, setSelectedId] = createSignal(options.strategy?.id || '');
  const [draft, setDraft] = createSignal(strategyDraft(options.strategy));
  // What the draft was opened as: the saved strategy, or the empty form for
  // a new one (a duplicate is new, so it starts unsaved).
  const [baseline, setBaseline] = createSignal(strategyDraft(options.strategy));
  // A strategy (or 'new' / 'back') waiting for "Discard and open" while the draft is unsaved.
  const [pending, setPending] = createSignal(null);
  const [touched, setTouched] = createSignal(false);
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  const [saved, setSaved] = createSignal('');

  const usedBy = () => (stored().find((entry) => entry.id === draft().id) || {}).groupNames || [];
  const problem = () => nameProblem(draft().name, draft().id, stored(), 'strategy');
  // The worked example's comp: the group's comp when it has the draft's source, else the sample.
  const example = createMemo(() => exampleSteps(draft(), pickExampleComp([options.exampleComp?.(), SAMPLE_COMP], draft()), ctx()));
  const unsaved = createMemo(() => draftChanged(draft(), baseline()));
  // The toggles this source's data can honour, and the block's title.
  const selectedSource = createMemo(() => editorSource(draft().source));
  const basisGroups = createMemo(() => editorBasisGroups(selectedSource()));
  const switches = () => sourceSwitches(draft().source, draft().basis);
  const togglesTitle = () => {
    if (draft().basis === 'sold') return 'Compare with sales that have';
    if (draft().source === 'cardtrader' || draft().source === 'cardmarketoffers') return 'Compare with offers that have';
    return 'Use the price for';
  };
  const allExactOn = () => PRICER_MATCHES.every(({ id }) => switches()[id] !== true || draft().match[id] === true);
  const basisHint = () => {
    const { source, basis } = draft();
    if (source === 'cardmarket') return 'From Cardmarket’s public price guide, refreshed daily. Prices are what buyers pay on Cardmarket, before its fees.';
    if (source === 'cardmarketoffers') return 'Asking prices we scanned on Cardmarket ourselves, kept for 7 days. A professional offer is a shop or powerseller, a private one an individual seller. Only the cards the scan has walked have a number.';
    if (source === 'tcgplayer') return 'TCGplayer prices are in US dollars. Pokoin converts them at the European Central Bank’s rate of the day.';
    if (source === 'pokoin' && basis === 'sold') return 'Sales on Pokoin in the last 90 days.';
    return '';
  };

  function edit(patch) {
    setDraft({ ...draft(), ...patch });
    setSaved('');
  }

  /** "All exact" sets only the honoured toggles; the others keep their saved value. */
  function setAllExact(on) {
    const match = { ...draft().match };
    for (const { id } of PRICER_MATCHES) if (switches()[id] === true) match[id] = on;
    edit({ match });
  }

  function open(strategy) {
    setSelectedId(strategy?.id || '');
    setDraft(strategyDraft(strategy));
    setBaseline(strategyDraft(strategy));
    setPending(null);
    setTouched(false);
    setError('');
    setSaved('');
  }

  /** Open another strategy, a new one, or go back; with unsaved edits, ask first. */
  function leaveTo(target) {
    if (unsaved()) {
      setPending({ target });
      return;
    }
    go(target);
  }

  function go(target) {
    if (target === 'back') {
      setPending(null);
      options.onBack?.();
    } else open(target === 'new' ? null : target);
  }

  function discard() {
    setDraft(baseline());
    setPending(null);
    setTouched(false);
    setError('');
  }

  const pendingName = () => {
    const target = pending()?.target;
    if (target === 'back') return 'go back to the pricing groups';
    if (target === 'new') return 'start a new strategy';
    return `open “${localizeStrategyName(target?.name, ctx()) || 'that strategy'}”`;
  };

  function duplicate() {
    const copy = { ...draft(), id: '', name: uniqueCopyName(draft().name, stored()) };
    setSelectedId('');
    setDraft(copy);
    setBaseline(strategyDraft(null));
    setPending(null);
    setTouched(true);
    setSaved('');
    setError('');
  }

  async function save() {
    setTouched(true);
    if (problem() || busy()) return;
    setBusy('save');
    setError('');
    try {
      const id = await options.save(draft());
      const next = stored().find((entry) => entry.id === id);
      setSelectedId(id);
      setDraft(strategyDraft(next || { ...draft(), id }));
      setBaseline(strategyDraft(next || { ...draft(), id }));
      setPending(null);
      setTouched(false);
      setSaved('Saved.');
      options.onSaved?.(next || { ...draft(), id });
      return id;
    } catch (err) {
      setError(err.message || 'Could not save the strategy.');
      return '';
    } finally {
      setBusy('');
    }
  }

  async function remove() {
    const id = draft().id;
    if (!id || usedBy().length) return;
    setBusy('delete');
    setError('');
    try {
      await options.remove(id);
      open(stored().find((entry) => entry.id !== id) || null);
    } catch (err) {
      // 409 strategy_in_use names the groups that still use it.
      setError(err.message || 'Could not delete the strategy.');
    } finally {
      setBusy('');
    }
  }

  return {
    draft,
    baseline,
    selectedId,
    touched,
    setTouched,
    pending,
    setPending,
    unsaved,
    problem,
    usedBy,
    pending,
    pendingName,
    busy,
    error,
    saved,
    example,
    ctx,
    selectedSource,
    basisGroups,
    switches,
    togglesTitle,
    allExactOn,
    basisHint,
    edit,
    setAllExact,
    open,
    leaveTo,
    go,
    discard,
    duplicate,
    save,
    remove,
  };
}

/**
 * The strategy editor's form: the name, "Start from" with its switches, "Then"
 * with the amounts, and the worked example. `editor` is `createStrategyEditor`.
 */
export default function StrategyEditor(props) {
  const editor = props.editor;
  const ctx = () => editor.ctx();
  return (
    <section class="mypokoin-card pricer-panel" aria-label="Edit strategy">
      <Show when={props.heading !== false}>
        <div class="pricer-editor-head">
          <h3 class="pricer-editor-title">{editor.draft().id ? 'Edit strategy' : 'New strategy'}</h3>
          <Show when={editor.unsaved()}>
            <span class="pricer-unsaved" role="status">Unsaved changes</span>
          </Show>
        </div>
      </Show>
      <Show when={editor.pending()}>
        <div class="pricer-confirm-leave" role="alertdialog" aria-label="Unsaved changes">
          <p>
            “{editor.draft().name.trim() || 'This strategy'}” has unsaved changes. Discard them and {editor.pendingName()}?
          </p>
          <div class="pricer-form-actions">
            <button type="button" class="btn pricer-danger" onClick={() => editor.go(editor.pending().target)}>Discard and continue</button>
            <button type="button" class="btn ghost" onClick={() => editor.setPending(null)}>Keep editing</button>
          </div>
        </div>
      </Show>
      <label class="ps-field pricer-name-field">
        <span>Name</span>
        <input
          value={editor.draft().name}
          maxLength={80}
          placeholder="Undercut 5% · CardTrader net"
          aria-invalid={editor.touched() && editor.problem() ? 'true' : undefined}
          onInput={(event) => editor.edit({ name: event.target.value })}
          onBlur={() => editor.setTouched(true)}
        />
      </label>
      <p class={editor.touched() && editor.problem() ? 'pricer-field-error' : 'pricer-hint'} role={editor.touched() && editor.problem() ? 'alert' : undefined}>
        {editor.touched() && editor.problem() ? editor.problem() : `Must be unique. ${editor.usedBy().length ? `${usedByLine(editor.usedBy())}.` : 'Not used by any group yet.'}`}
      </p>

      <fieldset class="pricer-fieldset">
        <legend>1 · Start from</legend>
        <div class="pricer-chips" role="group" aria-label="Market">
          <For each={EDITOR_SOURCES}>
            {(entry) => (
              <button
                type="button"
                class={['inv-chip', { on: editor.selectedSource() === entry.id }]}
                aria-pressed={String(editor.selectedSource() === entry.id)}
                title={entry.hint}
                onClick={() => { if (editor.selectedSource() !== entry.id) editor.edit(withSource(editor.draft(), entry.id)); }}
              >
                {entry.label}
              </button>
            )}
          </For>
        </div>
        <div class="pricer-basis-groups" role="radiogroup" aria-label="Start from">
          <For each={editor.basisGroups()}>
            {(group) => (
              <div class="pricer-basis-group">
                <Show when={group.label}><p class="pricer-basis-group-label">{group.label}</p></Show>
                <div class="pricer-bases">
                  <For each={group.entries}>
                    {(entry) => (
                      <label class={['pricer-basis', { on: editor.draft().source === entry.source && editor.draft().basis === entry.id }]}>
                        <input
                          type="radio"
                          name="pricer-basis"
                          value={`${entry.source}:${entry.id}`}
                          checked={editor.draft().source === entry.source && editor.draft().basis === entry.id}
                          onChange={() => editor.edit(withEditorBasis(editor.draft(), entry))}
                        />
                        <span><strong>{entry.label}</strong><small>{entry.hint}</small></span>
                      </label>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>
        <Show when={editor.basisHint()}>
          <p class="pricer-hint">{editor.basisHint()}</p>
        </Show>
        <Show
          when={showsSwitches(editor.draft())}
          fallback={<p class="pricer-hint">Pokoin: the cheapest Pokoin ask for the card, any copy.</p>}
        >
          <div class="pricer-toggles" role="group" aria-labelledby="pricer-toggles-title">
            <p class="pricer-toggles-title" id="pricer-toggles-title">{editor.togglesTitle()}</p>
            <label class="pricer-toggle is-all">
              <input
                type="checkbox"
                role="switch"
                checked={editor.allExactOn()}
                onChange={(event) => editor.setAllExact(event.target.checked)}
              />
              <span class="pricer-switch" aria-hidden="true" />
              <span>
                <strong>All exact</strong>
                <small>Every toggle below</small>
              </span>
            </label>
            <For each={PRICER_MATCHES}>
              {(entry) => {
                // A function: `For` renders each row once, the source can change after.
                const honoured = () => editor.switches()[entry.id] === true;
                return (
                  <label class={['pricer-toggle', { 'is-off': !honoured() }]}>
                    <input
                      type="checkbox"
                      role="switch"
                      disabled={!honoured()}
                      checked={!honoured() ? false : editor.draft().match[entry.id] === true}
                      onChange={(event) => editor.edit({ match: { ...editor.draft().match, [entry.id]: event.target.checked } })}
                    />
                    <span class="pricer-switch" aria-hidden="true" />
                    <span>
                      <strong>{entry.label}</strong>
                      <Show when={honoured()} fallback={<small>{switchNote(editor.draft().source)}</small>}>
                        <Show when={entry.hint}><small>{entry.hint}</small></Show>
                        </Show>
                    </span>
                  </label>
                );
              }}
            </For>
          </div>
        </Show>
        <Show when={sourceHasFees(editor.draft().source)}>
          <label class="ps-field ps-check">
            <input type="checkbox" checked={editor.draft().feeExclusive} onChange={(event) => editor.edit({ feeExclusive: event.target.checked })} />
            <span>Net of CardTrader fees (what you would net there)</span>
          </label>
        </Show>
      </fieldset>

      <fieldset class="pricer-fieldset">
        <legend>2 · Then</legend>
        <div class="pricer-chips" role="group" aria-label="Action">
          <For each={PRICER_ACTIONS}>
            {(entry) => (
              <button
                type="button"
                class={['inv-chip', { on: editor.draft().action === entry.id }]}
                aria-pressed={String(editor.draft().action === entry.id)}
                onClick={() => editor.edit({ action: entry.id })}
              >
                {entry.label}
              </button>
            )}
          </For>
        </div>
        <div class="pricer-grid">
          <Show when={editor.draft().action !== 'match'}>
            <label class="ps-field">
              <span>by %</span>
              <input type="number" inputMode="decimal" min="0" max="90" step="0.5" value={editor.draft().amountPct}
                onInput={(event) => editor.edit({ amountPct: numberInput(event.target.value) })} />
            </label>
            <label class="ps-field">
              <span>and {ctx().code}</span>
              <MoneyInput value={editor.draft().amountPkn} ctx={ctx()} onValue={(amountPkn) => editor.edit({ amountPkn })} />
            </label>
          </Show>
          <label class="ps-field">
            <span>Rounding</span>
            <select value={editor.draft().rounding} onChange={(event) => editor.edit({ rounding: event.target.value })}>
              <For each={PRICER_ROUNDINGS}>{(entry) => <option value={entry.id}>{entry.label}</option>}</For>
            </select>
          </label>
          <label class="ps-field">
            <span>Never below ({ctx().code})</span>
            <MoneyInput value={editor.draft().minPkn} ctx={ctx()} onValue={(minPkn) => editor.edit({ minPkn })} />
          </label>
        </div>
        <label class="ps-field ps-check">
          <input type="checkbox" checked={editor.draft().activatePaused} onChange={(event) => editor.edit({ activatePaused: event.target.checked })} />
          <span>Put paused listings on sale once they get a price</span>
        </label>
      </fieldset>

      <p class="pricer-example">
        <span class="pricer-example-label">Example</span>
        {' '}
        <Show when={!editor.example().noOffer} fallback={<span>{NO_OFFER}</span>}>
          {exampleLead(editor.example().steps)}
          <strong>{editor.example().target == null ? 'no price' : pkn(editor.example().target, ctx())}</strong>
        </Show>
      </p>

      <Alert>{editor.error()}</Alert>
      <Show when={editor.saved()}><p class="ct-connect-ok" role="status">{editor.saved()}</p></Show>
      <div class="pricer-form-actions">
        <Show when={editor.draft().id}>
          <button
            type="button"
            class="btn ghost pricer-danger"
            disabled={editor.usedBy().length > 0 || Boolean(editor.busy())}
            title={editor.usedBy().length ? 'Give its groups another strategy first' : undefined}
            onClick={() => editor.remove()}
          >
            {editor.busy() === 'delete' ? 'Deleting…' : 'Delete strategy'}
          </button>
        </Show>
        <button type="button" class="btn ghost" disabled={Boolean(editor.busy())} onClick={() => editor.duplicate()}>Duplicate</button>
        <Show when={editor.unsaved()}>
          <button type="button" class="btn ghost" disabled={Boolean(editor.busy())} onClick={() => editor.discard()}>Discard</button>
          <span class="pricer-unsaved">Unsaved changes</span>
        </Show>
        <button type="button" class="btn" disabled={Boolean(editor.busy()) || (editor.touched() && Boolean(editor.problem()))} onClick={() => editor.save()}>
          {editor.busy() === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>
      <Show when={editor.draft().id && editor.usedBy().length}>
        <p class="pricer-hint">{usedByLine(editor.usedBy())}: give {editor.usedBy().length === 1 ? 'that group' : 'those groups'} another strategy before deleting this one.</p>
      </Show>
    </section>
  );
}
