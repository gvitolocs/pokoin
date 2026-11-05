import { createMemo, createSignal, createUniqueId, For, Match, onCleanup, onSettled, Show, Switch } from 'solid-js';
import { Alert } from '../Desk.jsx';
import NewGroupForm from './NewGroupForm.jsx';
import {
  ActionIcon,
  BackIcon,
  BatchIcon,
  CalendarIcon,
  CloseIcon,
  GroupIcon,
  NoneIcon,
  PlusIcon,
  TagIcon,
} from './icons.jsx';
import { appliedLine, applyLabel, pkn, planCounts, strategyTile } from './pricer-ui.js';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const cardsLabel = (count) => `${count} ${count === 1 ? 'card' : 'cards'}`;
const setLine = (entry) => [entry.setName, entry.collectorNumber ? `#${entry.collectorNumber}` : ''].filter(Boolean).join(' · ');

/** One strategy as a tile: action icon, market, name, rule chips, switch chips, "Used by". */
function StrategyTile(props) {
  const tile = createMemo(() => strategyTile(props.strategy));
  return (
    <button
      type="button"
      class={['pricer-tile', { on: props.on }]}
      aria-pressed={props.pressable ? String(Boolean(props.on)) : undefined}
      disabled={props.disabled}
      onClick={() => props.onPick()}
    >
      <span class="pricer-tile-head">
        <span class={`pricer-tile-icon is-${tile().icon}`}><ActionIcon action={tile().icon} size={18} /></span>
        <span class="pricer-source">{tile().source}</span>
      </span>
      <strong class="pricer-tile-name">{props.strategy.name}</strong>
      <span class="pricer-tile-chips">
        <For each={tile().rules}>{(rule) => <span class="pricer-chip">{rule}</span>}</For>
      </span>
      <span class="pricer-tile-chips">
        <Show
          when={tile().sold}
          fallback={(
            <For each={tile().switches}>
              {(name) => <span class={['pricer-chip', 'is-switch', { 'is-exact': tile().allExact }]}>{name}</span>}
            </For>
          )}
        >
          <span class="pricer-chip is-switch"><CalendarIcon size={13} /> Sold median</span>
        </Show>
      </span>
      <Show when={props.strategy.groupNames?.length}>
        <small class="pricer-tile-used">Used by: {props.strategy.groupNames.join(', ')}</small>
      </Show>
    </button>
  );
}

/** One group as a tile: name, its strategy, card count, "Daily". */
function GroupTile(props) {
  return (
    <button
      type="button"
      class={['pricer-tile', 'is-group', { on: props.on }]}
      aria-pressed={props.pressable ? String(Boolean(props.on)) : undefined}
      disabled={props.disabled}
      onClick={() => props.onPick()}
    >
      <span class="pricer-tile-head">
        <span class="pricer-tile-icon"><GroupIcon size={18} /></span>
        <Show when={props.group.autoDaily}><span class="pricer-badge">Daily</span></Show>
      </span>
      <strong class="pricer-tile-name">{props.group.name}</strong>
      <span class="pricer-tile-meta">{props.strategyName} · {cardsLabel(Number(props.group.listingCount) || 0)}</span>
    </button>
  );
}

/**
 * The "Price selected" pop-up: the seller's strategies and groups as tiles
 * (Card Rails draws the same tiles from the same data, `strategyTile`).
 *
 * mode 'board' (listings): pick a tile → the new prices for `listingIds`
 *   (dry run) → Apply. A group adds the listings to it, then prices them.
 *   Props: pricing (the shared store), listingIds, onApplied().
 * mode 'rows' (Scan desk): pick a tile, "Batch default" or "No pricing" →
 *   `onChoose({ kind: 'strategy' | 'group' | 'batch' | 'none', id })`; no
 *   price is written. Props: current (the choice to mark), batchLabel,
 *   onChoose, onCreateGroup(input) → the new group's id.
 * Both: count, strategies, groups, onClose().
 */
export default function PricerPopup(props) {
  const titleId = createUniqueId();
  const rows = () => props.mode === 'rows';
  const [step, setStep] = createSignal(null);
  const [plan, setPlan] = createSignal(null);
  const [result, setResult] = createSignal(null);
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  const [creating, setCreating] = createSignal(false);
  let dialog;
  const opener = typeof document !== 'undefined' ? document.activeElement : null;

  const strategyName = (id) => props.strategies.find((entry) => entry.id === id)?.name || 'No strategy';
  const chosenName = () => {
    const current = step();
    if (!current) return '';
    return current.kind === 'group'
      ? props.groups.find((entry) => entry.id === current.id)?.name || 'Group'
      : strategyName(current.id);
  };

  const focusFirst = () => (dialog?.querySelector('.pricer-tile') || dialog?.querySelector(FOCUSABLE))?.focus();

  onSettled(() => {
    focusFirst();
    // Esc closes and Tab comes back in wherever focus is (a removed button
    // leaves it on the page body).
    const onDocKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (busy() !== 'apply') props.onClose();
      } else if (event.key === 'Tab' && dialog && !dialog.contains(document.activeElement)) {
        event.preventDefault();
        focusFirst();
      }
    };
    document.addEventListener('keydown', onDocKey, true);
    return () => document.removeEventListener('keydown', onDocKey, true);
  });
  onCleanup(() => {
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
  });

  function onKeyDown(event) {
    if (event.key !== 'Tab' || !dialog) return;
    // Focus stays inside the dialog.
    const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((node) => node.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function back() {
    setStep(null);
    setPlan(null);
    setResult(null);
    setError('');
    queueMicrotask(focusFirst);
  }

  /** Board mode: the dry run for a tile; rows mode: the choice itself. */
  async function pick(choice) {
    setError('');
    if (rows()) {
      props.onChoose(choice);
      return;
    }
    setStep(choice);
    setPlan(null);
    setResult(null);
    setBusy('plan');
    try {
      const strategyId = choice.kind === 'group'
        ? props.groups.find((entry) => entry.id === choice.id)?.strategyId
        : choice.id;
      // A group's preview uses its strategy: the listings join the group on Apply.
      setPlan(await props.pricing.apply({ strategyId, listingIds: props.listingIds, dryRun: true }));
    } catch (err) {
      setError(err.message || 'Could not check the prices.');
    } finally {
      setBusy('');
    }
    queueMicrotask(() => dialog?.querySelector('.pricer-popup-preview .btn')?.focus());
  }

  async function apply() {
    const choice = step();
    if (!choice) return;
    setBusy('apply');
    setError('');
    try {
      let answer;
      let joined = '';
      if (choice.kind === 'group') {
        await props.pricing.saveGroup({ groupId: choice.id, add: props.listingIds });
        joined = `Added ${cardsLabel(props.listingIds.length)} to ${chosenName()}.`;
        answer = await props.pricing.apply({ groupId: choice.id, listingIds: props.listingIds });
      } else {
        answer = await props.pricing.apply({ strategyId: choice.id, listingIds: props.listingIds });
      }
      setResult({ answer, joined });
      props.onApplied?.();
    } catch (err) {
      setError(err.message || 'Applying the prices failed.');
    } finally {
      setBusy('');
    }
  }

  async function createGroup(input) {
    if (rows()) {
      const id = await props.onCreateGroup(input);
      setCreating(false);
      if (id) props.onChoose({ kind: 'group', id });
      return;
    }
    const answer = await props.pricing.saveGroup({ group: input });
    setCreating(false);
    if (answer?.groupId) pick({ kind: 'group', id: answer.groupId });
  }

  const isCurrent = (kind, id) => rows() && props.current?.kind === kind && (id == null || props.current?.id === id);
  const counts = () => planCounts(plan()?.plan || []);

  return (
    <div
      class="pricer-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && busy() !== 'apply') props.onClose();
      }}
    >
      <div
        class="pricer-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={(node) => { dialog = node; }}
        onKeyDown={onKeyDown}
        data-testid="pricer-popup"
      >
        <header class="pricer-modal-head">
          <Show when={step() && !rows()}>
            <button type="button" class="pricer-icon-btn" aria-label="Back to the strategies" disabled={busy() === 'apply'}
              onClick={back}>
              <BackIcon />
            </button>
          </Show>
          <span class="pricer-modal-mark"><TagIcon size={22} /></span>
          <div class="pricer-modal-title">
            <h2 id={titleId}>Price {cardsLabel(props.count)}</h2>
            <p class="pricer-modal-lede">
              {step() && !rows()
                ? `${chosenName()}: the new prices, before anything changes.`
                : rows()
                  ? 'Pick a strategy or a group for these rows. Prices are set when the batch loads.'
                  : "Pick a strategy or a group. You'll see the new prices before anything changes."}
            </p>
          </div>
          <button type="button" class="pricer-icon-btn" aria-label="Close" onClick={() => props.onClose()}><CloseIcon /></button>
        </header>

        <div class="pricer-modal-body">
          <Alert>{error()}</Alert>
          <Switch>
            <Match when={!step() || rows()}>
              <Show when={rows()}>
                <div class="pricer-tile-grid is-compact">
                  <button type="button" class={['pricer-tile', 'is-plain', { on: isCurrent('batch') }]} aria-pressed={String(isCurrent('batch'))}
                    onClick={() => pick({ kind: 'batch' })}>
                    <span class="pricer-tile-head"><span class="pricer-tile-icon"><BatchIcon size={18} /></span></span>
                    <strong class="pricer-tile-name">Batch default</strong>
                    <span class="pricer-tile-meta">{props.batchLabel || 'No pricing'}</span>
                  </button>
                  <button type="button" class={['pricer-tile', 'is-plain', { on: isCurrent('none') }]} aria-pressed={String(isCurrent('none'))}
                    onClick={() => pick({ kind: 'none' })}>
                    <span class="pricer-tile-head"><span class="pricer-tile-icon"><NoneIcon size={18} /></span></span>
                    <strong class="pricer-tile-name">No pricing</strong>
                    <span class="pricer-tile-meta">Stay unpriced; type a price yourself</span>
                  </button>
                </div>
              </Show>

              <h3 class="pricer-modal-section">Strategies</h3>
              <Show
                when={props.strategies.length}
                fallback={<p class="pricer-note">No strategies yet. Make one in MyPokoin → Pricer → Strategies.</p>}
              >
                <div class="pricer-tile-grid">
                  <For each={props.strategies} keyed={(entry) => entry.id}>
                    {(entry) => (
                      <StrategyTile
                        strategy={entry()}
                        pressable={rows()}
                        on={isCurrent('strategy', entry().id)}
                        disabled={Boolean(busy())}
                        onPick={() => pick({ kind: 'strategy', id: entry().id })}
                      />
                    )}
                  </For>
                </div>
              </Show>

              <h3 class="pricer-modal-section">Put them in a group</h3>
              <div class="pricer-tile-grid">
                <For each={props.groups} keyed={(entry) => entry.id}>
                  {(entry) => (
                    <GroupTile
                      group={entry()}
                      strategyName={strategyName(entry().strategyId)}
                      pressable={rows()}
                      on={isCurrent('group', entry().id)}
                      disabled={Boolean(busy())}
                      onPick={() => pick({ kind: 'group', id: entry().id })}
                    />
                  )}
                </For>
                <button
                  type="button"
                  class={['pricer-tile', 'is-new', { on: creating() }]}
                  aria-expanded={String(creating())}
                  disabled={!props.strategies.length}
                  onClick={() => setCreating(!creating())}
                >
                  <span class="pricer-tile-head"><span class="pricer-tile-icon"><PlusIcon size={18} /></span></span>
                  <strong class="pricer-tile-name">New group…</strong>
                  <span class="pricer-tile-meta">Name it and pick its strategy</span>
                </button>
              </div>
              <Show when={creating()}>
                <NewGroupForm
                  class="pricer-popup-form"
                  idPrefix={`${titleId}-group`}
                  groups={props.groups}
                  strategies={props.strategies}
                  submitLabel={rows() ? 'Create and use' : 'Create and preview'}
                  onCreate={createGroup}
                  onCancel={() => setCreating(false)}
                />
              </Show>
              <Show when={rows()}>
                <p class="pricer-note pricer-popup-meaning">
                  Unpriced rows get this price when the batch loads; rows with a price keep it.
                  A group also takes the cards in when they are listed.
                </p>
              </Show>
            </Match>

            <Match when={step()}>
              <div class="pricer-popup-preview">
                <Show when={plan()} fallback={<p class="pricer-muted">{busy() === 'plan' ? 'Checking prices…' : ''}</p>}>
                  {(answer) => (
                    <>
                      <p class="pricer-popup-counts">
                        <strong>{counts().prices}</strong> {counts().prices === 1 ? 'price changes' : 'prices change'}
                        {' · '}{counts().onSale} go on sale
                        {' · '}{answer().noComp} without a market price
                        {' · '}{answer().unchanged} already there
                      </p>
                      <Show when={answer().plan.length}>
                        <div class="pricer-table-wrap">
                          <table class="pricer-plan">
                            <thead>
                              <tr><th>Card</th><th class="num">Now → new</th><th class="num">Market</th></tr>
                            </thead>
                            <tbody>
                              <For each={answer().plan}>
                                {(entry) => (
                                  <tr>
                                    <td><strong>{entry.cardName || 'Listing'}</strong><small>{setLine(entry)}</small></td>
                                    <td class="num">
                                      {entry.current ? pkn(entry.current) : '—'} → <span class="pricer-new">{pkn(entry.target)}</span>
                                      <Show when={entry.activate}><small class="pricer-on-sale">goes on sale</small></Show>
                                    </td>
                                    <td class="num">
                                      {entry.compPkn != null ? pkn(entry.compPkn) : '—'}
                                      <Show when={entry.askPkn && entry.askPkn !== entry.compPkn}><small>ask {pkn(entry.askPkn)}</small></Show>
                                    </td>
                                  </tr>
                                )}
                              </For>
                            </tbody>
                          </table>
                        </div>
                      </Show>
                    </>
                  )}
                </Show>
                <Show when={result()}>
                  {(done) => (
                    <p class="ct-connect-ok" role="status">{[done().joined, appliedLine(done().answer)].filter(Boolean).join(' ')}</p>
                  )}
                </Show>
                <div class="pricer-form-actions pricer-popup-actions">
                  <Show
                    when={!result()}
                    fallback={<button type="button" class="btn" onClick={() => props.onClose()}>Done</button>}
                  >
                    <button type="button" class="btn ghost" disabled={busy() === 'apply'} onClick={back}>
                      Back
                    </button>
                    <button
                      type="button"
                      class="btn"
                      disabled={!plan() || Boolean(busy()) || (!plan().plan.length && step()?.kind !== 'group')}
                      onClick={apply}
                    >
                      {busy() === 'apply'
                        ? 'Applying…'
                        : step()?.kind === 'group' && !plan()?.plan.length
                          ? `Add ${cardsLabel(props.count)} to ${chosenName()}`
                          : applyLabel(plan()?.plan || [])}
                    </button>
                  </Show>
                </div>
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </div>
  );
}
