import { createEffect, createMemo, createSignal, For, Show, untrack } from 'solid-js';
import {
  localizeStrategyName,
  localToPkn,
  nameProblem,
  pknToLocal,
  PRICER_ACTIONS,
  PRICER_MATCHES,
  PRICER_ROUNDINGS,
  PRICER_SOURCES,
  pricerBases,
  sourceHasFees,
  sourceSwitches,
  strategySummary,
  switchNote,
} from '@market/pricer.js';
import { Alert } from '../Desk.jsx';
import {
  draftChanged,
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
 * Pricer → Strategies: the seller's named pricing rules and their editor.
 * A strategy says how to price, never which cards: groups pick one by name.
 */
export default function StrategiesPanel(props) {
  const pricing = props.pricing;
  const ctx = () => pricing.currencyCtx();
  const first = untrack(() => pricing.strategies()[0] || null);
  const [selectedId, setSelectedId] = createSignal(first?.id || '');
  const [draft, setDraft] = createSignal(strategyDraft(first));
  // What the draft was opened as: the saved strategy, or the empty form for
  // a new one (a duplicate is new, so it starts unsaved).
  const [baseline, setBaseline] = createSignal(strategyDraft(first));
  // A strategy (or 'new' / 'back') waiting for "Discard and open" while the draft is unsaved.
  const [pending, setPending] = createSignal(null);
  const [touched, setTouched] = createSignal(false);
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  const [saved, setSaved] = createSignal('');

  const stored = createMemo(() => pricing.strategies().find((entry) => entry.id === draft().id) || null);
  const usedBy = () => stored()?.groupNames || [];
  const problem = () => nameProblem(draft().name, draft().id, pricing.strategies(), 'strategy');
  // The worked example's comp: the group's comp when it has the draft's source, else the sample.
  const example = createMemo(() => exampleSteps(draft(), pickExampleComp([props.exampleComp, SAMPLE_COMP], draft()), ctx()));
  const unsaved = createMemo(() => draftChanged(draft(), baseline()));
  // The toggles this source's data can honour, and the block's title.
  const switches = () => sourceSwitches(draft().source, draft().basis);
  const togglesTitle = () => {
    if (draft().basis === 'sold') return 'Compare with sales that have';
    if (draft().source === 'cardtrader' || draft().source === 'cardmarketoffers') return 'Compare with offers that have';
    return 'Use the price for';
  };
  const allExactOn = () => PRICER_MATCHES.every(({ id }) => switches()[id] !== true || draft().match[id] === true);
  /** "All exact" sets only the honoured toggles; the others keep their saved value. */
  const setAllExact = (on) => {
    const match = { ...draft().match };
    for (const { id } of PRICER_MATCHES) if (switches()[id] === true) match[id] = on;
    edit({ match });
  };
  const basisHint = () => {
    const { source, basis } = draft();
    if (source === 'cardmarket') return 'From Cardmarket’s public price guide, refreshed daily. Prices are what buyers pay on Cardmarket, before its fees.';
    if (source === 'cardmarketoffers') return 'Asking prices we scanned on Cardmarket ourselves, kept for 7 days. A professional offer is a shop or powerseller, a private one an individual seller. Only the cards the scan has walked have a number.';
    if (source === 'tcgplayer') return 'TCGplayer prices are in US dollars. Pokoin converts them at the European Central Bank’s rate of the day.';
    if (source === 'pokoin' && basis === 'sold') return 'Sales on Pokoin in the last 90 days.';
    return '';
  };

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
      props.onBack?.();
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

  // Opened before the strategies arrived: show the first one once they do.
  createEffect(() => pricing.strategies()[0]?.id || '', (id) => {
    const current = untrack(draft);
    if (id && !current.id && !current.name && !untrack(touched)) open(untrack(() => pricing.strategies()[0]));
  });

  const edit = (patch) => {
    setDraft({ ...draft(), ...patch });
    setSaved('');
  };

  function duplicate() {
    const copy = { ...draft(), id: '', name: uniqueCopyName(draft().name, pricing.strategies()) };
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
      const id = await pricing.saveStrategy(draft());
      const next = pricing.strategies().find((entry) => entry.id === id);
      setSelectedId(id);
      setDraft(strategyDraft(next || { ...draft(), id }));
      setBaseline(strategyDraft(next || { ...draft(), id }));
      setPending(null);
      setTouched(false);
      setSaved('Saved.');
    } catch (err) {
      setError(err.message || 'Could not save the strategy.');
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
      await pricing.deleteStrategy(id);
      open(pricing.strategies().find((entry) => entry.id !== id) || null);
    } catch (err) {
      // 409 strategy_in_use names the groups that still use it.
      setError(err.message || 'Could not delete the strategy.');
    } finally {
      setBusy('');
    }
  }

  return (
    <div class="pricer-tab pricer-strategies">
      <button type="button" class="pricer-back" onClick={() => leaveTo('back')}>← Pricing groups</button>
      <div class="mypokoin-panel-head">
        <div>
          <h2>Strategies</h2>
          <p class="mypokoin-help">A strategy is a named rule for how to price. Groups and batch uploads pick one by name.</p>
        </div>
        <button type="button" class="btn" onClick={() => leaveTo('new')}>New strategy</button>
      </div>
      <Alert>{pricing.error()}</Alert>

      <div class="pricer-cols">
        <div class="pricer-side">
          <Show
            when={pricing.strategies().length}
            fallback={<p class="pricer-note">No strategies yet. Fill in the form to make your first one.</p>}
          >
            <ul class="pricer-group-list" aria-label="Saved strategies">
              <For each={pricing.strategies()} keyed={(entry) => entry.id}>
                {(entry) => (
                  <li>
                    <button
                      type="button"
                      class={['pricer-group-item', { on: entry().id === selectedId() && entry().id === draft().id }]}
                      aria-pressed={String(entry().id === selectedId() && entry().id === draft().id)}
                      onClick={() => (entry().id === draft().id ? undefined : leaveTo(entry()))}
                    >
                      <strong>{localizeStrategyName(entry().name, ctx())}</strong>
                      {/* The server's `summary` stays in PKN; the seller reads their own currency. */}
                      <span class="pricer-group-sub">{strategySummary(entry(), ctx())}</span>
                      <span class="pricer-group-sub">{usedByLine(entry().groupNames)}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>

        <section class="mypokoin-card pricer-panel" aria-label="Edit strategy">
          <div class="pricer-editor-head">
            <h3 class="pricer-editor-title">{draft().id ? 'Edit strategy' : 'New strategy'}</h3>
            <Show when={unsaved()}>
              <span class="pricer-unsaved" role="status">Unsaved changes</span>
            </Show>
          </div>
          <Show when={pending()}>
            <div class="pricer-confirm-leave" role="alertdialog" aria-label="Unsaved changes">
              <p>
                “{draft().name.trim() || 'This strategy'}” has unsaved changes. Discard them and {pendingName()}?
              </p>
              <div class="pricer-form-actions">
                <button type="button" class="btn pricer-danger" onClick={() => go(pending().target)}>Discard and continue</button>
                <button type="button" class="btn ghost" onClick={() => setPending(null)}>Keep editing</button>
              </div>
            </div>
          </Show>
          <label class="ps-field pricer-name-field">
            <span>Name</span>
            <input
              value={draft().name}
              maxLength={80}
              placeholder="Undercut 5% · CardTrader net"
              aria-invalid={touched() && problem() ? 'true' : undefined}
              onInput={(event) => edit({ name: event.target.value })}
              onBlur={() => setTouched(true)}
            />
          </label>
          <p class={touched() && problem() ? 'pricer-field-error' : 'pricer-hint'} role={touched() && problem() ? 'alert' : undefined}>
            {touched() && problem() ? problem() : `Must be unique. ${usedBy().length ? `${usedByLine(usedBy())}.` : 'Not used by any group yet.'}`}
          </p>

          <fieldset class="pricer-fieldset">
            <legend>1 · Start from</legend>
            <div class="pricer-chips" role="group" aria-label="Market">
              <For each={PRICER_SOURCES}>
                {(entry) => (
                  <button
                    type="button"
                    class={['inv-chip', { on: draft().source === entry.id }]}
                    aria-pressed={String(draft().source === entry.id)}
                    title={entry.hint}
                    onClick={() => edit(withSource(draft(), entry.id))}
                  >
                    {entry.label}
                  </button>
                )}
              </For>
            </div>
            <div class="pricer-bases" role="radiogroup" aria-label="Start from">
              <For each={pricerBases(draft().source)}>
                {(entry) => (
                  <label class={['pricer-basis', { on: draft().basis === entry.id }]}>
                    <input
                      type="radio"
                      name="pricer-basis"
                      value={entry.id}
                      checked={draft().basis === entry.id}
                      onChange={() => edit({ basis: entry.id })}
                    />
                    <span>
                      <strong>{entry.label}</strong>
                      <small>{entry.hint}</small>
                    </span>
                  </label>
                )}
              </For>
            </div>
            <Show when={basisHint()}>
              <p class="pricer-hint">{basisHint()}</p>
            </Show>
            <Show
              when={showsSwitches(draft())}
              fallback={<p class="pricer-hint">Pokoin: the cheapest Pokoin ask for the card, any copy.</p>}
            >
              <div class="pricer-toggles" role="group" aria-labelledby="pricer-toggles-title">
                <p class="pricer-toggles-title" id="pricer-toggles-title">{togglesTitle()}</p>
                <label class="pricer-toggle is-all">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={allExactOn()}
                    onChange={(event) => setAllExact(event.target.checked)}
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
                    const honoured = () => switches()[entry.id] === true;
                    return (
                      <label class={['pricer-toggle', { 'is-off': !honoured() }]}>
                        <input
                          type="checkbox"
                          role="switch"
                          disabled={!honoured()}
                          checked={!honoured() ? false : draft().match[entry.id] === true}
                          onChange={(event) => edit({ match: { ...draft().match, [entry.id]: event.target.checked } })}
                        />
                        <span class="pricer-switch" aria-hidden="true" />
                        <span>
                          <strong>{entry.label}</strong>
                          <Show when={honoured()} fallback={<small>{switchNote(draft().source)}</small>}>
                            <Show when={entry.hint}><small>{entry.hint}</small></Show>
                            </Show>
                        </span>
                      </label>
                    );
                  }}
                </For>
              </div>
            </Show>
            <Show when={sourceHasFees(draft().source)}>
              <label class="ps-field ps-check">
                <input type="checkbox" checked={draft().feeExclusive} onChange={(event) => edit({ feeExclusive: event.target.checked })} />
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
                    class={['inv-chip', { on: draft().action === entry.id }]}
                    aria-pressed={String(draft().action === entry.id)}
                    onClick={() => edit({ action: entry.id })}
                  >
                    {entry.label}
                  </button>
                )}
              </For>
            </div>
            <div class="pricer-grid">
              <Show when={draft().action !== 'match'}>
                <label class="ps-field">
                  <span>by %</span>
                  <input type="number" inputMode="decimal" min="0" max="90" step="0.5" value={draft().amountPct}
                    onInput={(event) => edit({ amountPct: numberInput(event.target.value) })} />
                </label>
                <label class="ps-field">
                  <span>and {ctx().code}</span>
                  <MoneyInput value={draft().amountPkn} ctx={ctx()} onValue={(amountPkn) => edit({ amountPkn })} />
                </label>
              </Show>
              <label class="ps-field">
                <span>Rounding</span>
                <select value={draft().rounding} onChange={(event) => edit({ rounding: event.target.value })}>
                  <For each={PRICER_ROUNDINGS}>{(entry) => <option value={entry.id}>{entry.label}</option>}</For>
                </select>
              </label>
              <label class="ps-field">
                <span>Never below ({ctx().code})</span>
                <MoneyInput value={draft().minPkn} ctx={ctx()} onValue={(minPkn) => edit({ minPkn })} />
              </label>
            </div>
            <label class="ps-field ps-check">
              <input type="checkbox" checked={draft().activatePaused} onChange={(event) => edit({ activatePaused: event.target.checked })} />
              <span>Put paused listings on sale once they get a price</span>
            </label>
          </fieldset>

          <p class="pricer-example">
            <span class="pricer-example-label">Example</span>
            {' '}
            <Show when={!example().noOffer} fallback={<span>{NO_OFFER}</span>}>
              {exampleLead(example().steps)}
              <strong>{example().target == null ? 'no price' : pkn(example().target, ctx())}</strong>
            </Show>
          </p>

          <Alert>{error()}</Alert>
          <Show when={saved()}><p class="ct-connect-ok" role="status">{saved()}</p></Show>
          <div class="pricer-form-actions">
            <Show when={draft().id}>
              <button
                type="button"
                class="btn ghost pricer-danger"
                disabled={usedBy().length > 0 || Boolean(busy())}
                title={usedBy().length ? 'Give its groups another strategy first' : undefined}
                onClick={remove}
              >
                {busy() === 'delete' ? 'Deleting…' : 'Delete strategy'}
              </button>
            </Show>
            <button type="button" class="btn ghost" disabled={Boolean(busy())} onClick={duplicate}>Duplicate</button>
            <Show when={unsaved()}>
              <button type="button" class="btn ghost" disabled={Boolean(busy())} onClick={discard}>Discard</button>
              <span class="pricer-unsaved">Unsaved changes</span>
            </Show>
            <button type="button" class="btn" disabled={Boolean(busy()) || (touched() && Boolean(problem()))} onClick={save}>
              {busy() === 'save' ? 'Saving…' : 'Save'}
            </button>
          </div>
          <Show when={draft().id && usedBy().length}>
            <p class="pricer-hint">{usedByLine(usedBy())}: give {usedBy().length === 1 ? 'that group' : 'those groups'} another strategy before deleting this one.</p>
          </Show>
        </section>
      </div>
    </div>
  );
}
