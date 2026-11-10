import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { lastAppliedLine, nameProblem, ungroupedCount } from '@market/pricer.js';
import { Alert } from '../Desk.jsx';
import NewGroupForm from './NewGroupForm.jsx';
import StrategiesPanel from './StrategiesPanel.jsx';
import {
  appliedLine,
  applyLabel,
  pickExampleComp,
  pkn,
  planCounts,
  removeResultLine,
  selectRows,
  selectionState,
  toggleSelected,
  unchangedMarket,
  unchangedMembers,
} from './pricer-ui.js';

const cardsLabel = (count) => `${count} ${count === 1 ? 'card' : 'cards'}`;
const statusLabel = (status) => (String(status || 'active').toLowerCase() === 'paused' ? 'Paused' : 'Live');
const condLang = (row) => [row?.condition, row?.language].filter(Boolean).join(' · ') || '—';
const setLine = (row) => {
  const set = String(row?.setName || row?.set_name || '').trim();
  const number = String(row?.collectorNumber || row?.collector_number || '').trim();
  return [set, number ? `#${number}` : ''].filter(Boolean).join(' · ');
};

/** A plan row's market number: the comp, with the CardTrader ask in small text. */
function Market(props) {
  return (
    <Show when={props.compPkn != null} fallback="—">
      {pkn(props.compPkn, props.ctx)}
      <Show when={props.askPkn && props.askPkn !== props.compPkn}><small>ask {pkn(props.askPkn, props.ctx)}</small></Show>
    </Show>
  );
}

function Tile(props) {
  return (
    <div class={['inv-stat', props.tone ? `is-${props.tone}` : '']}>
      <strong>{props.value}</strong>
      <span>{props.label}</span>
    </div>
  );
}

/**
 * The selected group: name, strategy, daily, delete, the dry-run plan and
 * Apply. Its cards come from the board's rows and the memberships.
 */
function GroupPanel(props) {
  const pricing = props.pricing;
  const group = () => props.group;
  const [name, setName] = createSignal(() => props.group.name);
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  const [note, setNote] = createSignal('');
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [checked, setChecked] = createSignal(new Set());
  const [applied, setApplied] = createSignal(null);
  const nameError = () => nameProblem(name(), group().id, pricing.groups(), 'group');

  async function save(patch) {
    const current = group();
    setBusy('save');
    setError('');
    try {
      await pricing.saveGroup({
        group: { id: current.id, name: current.name, strategyId: current.strategyId, autoDaily: current.autoDaily === true, ...patch },
      });
    } catch (err) {
      setError(err.message || 'Could not save the group.');
    } finally {
      setBusy('');
    }
  }

  function saveName() {
    const next = name().trim();
    if (next === group().name || nameError()) return;
    save({ name: next });
  }

  async function remove() {
    setBusy('delete');
    setError('');
    try {
      await pricing.deleteGroup(group().id);
    } catch (err) {
      setError(err.message || 'Could not delete the group.');
    } finally {
      setBusy('');
    }
  }

  const plan = () => props.plan?.plan || [];
  const strategy = () => pricing.strategies().find((entry) => entry.id === group().strategyId) || null;
  const unchanged = createMemo(() => unchangedMembers(props.rows || [], pricing.memberships(), group().id, plan()));
  const memberCount = () => [...pricing.memberships().values()].filter((id) => id === group().id).length;
  const counts = () => planCounts(plan());
  const listIds = () => [...plan().map((entry) => entry.listingId), ...unchanged().map((row) => String(row.id))];
  const allState = () => selectionState(checked(), listIds());

  async function removeChecked() {
    const ids = [...checked()];
    if (!ids.length) return;
    setBusy('remove');
    setError('');
    try {
      const answer = await pricing.saveGroup({ remove: ids });
      setChecked(new Set());
      setNote(removeResultLine(answer.removed ?? ids.length));
    } catch (err) {
      setError(err.message || 'Could not take the cards out of the group.');
    } finally {
      setBusy('');
    }
  }

  async function applyNow() {
    setBusy('apply');
    setError('');
    setApplied(null);
    try {
      const answer = await pricing.apply({ groupId: group().id });
      setApplied(answer);
      props.onApplied?.();
    } catch (err) {
      setError(err.message || 'Applying the prices failed.');
    } finally {
      setBusy('');
    }
  }

  const nameOf = (listingId) => {
    const entry = plan().find((row) => row.listingId === listingId)
      || (props.rows || []).find((row) => String(row.id) === listingId);
    return entry?.cardName || entry?.name || listingId;
  };

  return (
    <section class="mypokoin-card pricer-panel" aria-label="Selected group">
      <div class="pricer-group-form">
        <label class="ps-field pricer-name-field">
          <span>Group name</span>
          <input
            value={name()}
            maxLength={80}
            aria-invalid={nameError() ? 'true' : undefined}
            onInput={(event) => setName(event.target.value)}
            onBlur={saveName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                saveName();
              }
            }}
          />
        </label>
        <label class="ps-field">
          <span>Strategy</span>
          <select value={group().strategyId} disabled={busy() === 'save'} onChange={(event) => save({ strategyId: event.target.value })}>
            <For each={pricing.strategies()}>{(entry) => <option value={entry.id}>{entry.name}</option>}</For>
          </select>
        </label>
        <label class="ps-field ps-check">
          <input type="checkbox" checked={group().autoDaily === true} onChange={(event) => save({ autoDaily: event.target.checked })} />
          <span>Reprice every day</span>
        </label>
        <div class="pricer-form-actions">
          <Show
            when={confirmDelete()}
            fallback={<button type="button" class="btn ghost pricer-danger" onClick={() => setConfirmDelete(true)}>Delete group</button>}
          >
            <span class="pricer-confirm" role="group" aria-label="Confirm delete">
              <span>Delete “{group().name}”? Its cards keep their prices.</span>
              <button type="button" class="btn pricer-danger" disabled={busy() === 'delete'} onClick={remove}>
                {busy() === 'delete' ? 'Deleting…' : 'Delete'}
              </button>
              <button type="button" class="btn ghost" onClick={() => setConfirmDelete(false)}>Keep</button>
            </span>
          </Show>
        </div>
      </div>
      <Show when={nameError()}><p class="pricer-field-error" role="alert">{nameError()}</p></Show>
      <Alert>{error() || props.planError}</Alert>

      <Show
        when={memberCount() > 0}
        fallback={(
          <div class="pricer-empty">
            <strong>Add cards from the Listings board</strong>
            <p class="mypokoin-help">Tick cards on the board, then “Add to group ▾” → {group().name}.</p>
            <a class="btn" href={props.boardHref}>Open Listings</a>
          </div>
        )}
      >
        <div class="pricer-tiles">
          <Tile value={memberCount()} label="Cards" />
          <Tile value={props.plan ? counts().prices : '…'} label="Price changes" tone="gold" />
          <Tile value={props.plan ? counts().onSale : '…'} label="Go on sale" />
          <Tile value={props.plan ? props.plan.noComp : '…'} label="No market price" />
        </div>

        <div class="pricer-table-wrap">
          <table class="pricer-plan">
            <thead>
              <tr>
                <th class="pricer-pick">
                  <input
                    type="checkbox"
                    aria-label="Select all cards in the group"
                    checked={allState() === 'all'}
                    prop:indeterminate={allState() === 'some'}
                    onChange={(event) => setChecked(selectRows(checked(), listIds(), event.target.checked))}
                  />
                </th>
                <th>Card</th>
                <th>Cond · Lang</th>
                <th>Status</th>
                <th class="num">Market</th>
                <th class="num">Now</th>
                <th class="num">New</th>
              </tr>
            </thead>
            <tbody>
              <Show when={!props.plan}>
                <tr><td colSpan={7} class="pricer-muted">Checking prices…</td></tr>
              </Show>
              <For each={plan()}>
                {(entry) => (
                  <tr>
                    <td class="pricer-pick">
                      <input
                        type="checkbox"
                        aria-label={`Select ${entry.cardName || 'listing'}`}
                        checked={checked().has(entry.listingId)}
                        onChange={() => setChecked(toggleSelected(checked(), entry.listingId))}
                      />
                    </td>
                    <td>
                      <strong>{entry.cardName || 'Listing'}</strong>
                      <small>{setLine(entry)}</small>
                    </td>
                    <td>{condLang(entry)}</td>
                    <td>{statusLabel(entry.status)}</td>
                    <td class="num"><Market compPkn={entry.compPkn} askPkn={entry.askPkn} ctx={pricing.currencyCtx()} /></td>
                    <td class="num">{entry.current ? pkn(entry.current, pricing.currencyCtx()) : '—'}</td>
                    <td class="num pricer-new">
                      {pkn(entry.target, pricing.currencyCtx())}
                      <Show when={entry.activate}><small>goes on sale</small></Show>
                    </td>
                  </tr>
                )}
              </For>
              <For each={props.plan ? unchanged() : []}>
                {(row) => (
                  <tr class="is-same">
                    <td class="pricer-pick">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.cardName || 'listing'}`}
                        checked={checked().has(String(row.id))}
                        onChange={() => setChecked(toggleSelected(checked(), row.id))}
                      />
                    </td>
                    <td>
                      <strong>{row.cardName || row.name || 'Listing'}</strong>
                      <small>{setLine(row)}</small>
                    </td>
                    <td>{condLang(row)}</td>
                    <td>{statusLabel(row.status)}</td>
                    <td class="num">
                      <Market
                        compPkn={unchangedMarket(pricing.compFor(row), strategy()).compPkn}
                        askPkn={unchangedMarket(pricing.compFor(row), strategy()).askPkn}
                        ctx={pricing.currencyCtx()}
                      />
                    </td>
                    <td class="num">{pkn(row.pricePkn ?? row.price_pkn, pricing.currencyCtx())}</td>
                    <td class="num">No change</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>

        <div class="pricer-apply-bar">
          <button
            type="button"
            class="btn ghost"
            disabled={!checked().size || Boolean(busy())}
            onClick={removeChecked}
          >
            {busy() === 'remove' ? 'Removing…' : checked().size ? `Remove ${checked().size} from group` : 'Remove from group'}
          </button>
          <button
            type="button"
            class="btn pricer-apply"
            disabled={!props.plan || !plan().length || Boolean(busy())}
            onClick={applyNow}
          >
            {busy() === 'apply' ? 'Applying…' : applyLabel(plan())}
          </button>
        </div>
      </Show>
      <Show when={note()}><p class="ct-connect-ok" role="status">{note()}</p></Show>
      <Show when={applied()}>
        {(answer) => (
          <div class="pricer-applied" role="status">
            <p class={answer().failed?.length ? 'mypokoin-help' : 'ct-connect-ok'}>{appliedLine(answer())}</p>
            <Show when={answer().failed?.length}>
              <ul class="pricer-failed">
                <For each={answer().failed}>{(entry) => <li>{nameOf(String(entry.listingId))}: {entry.error}</li>}</For>
              </ul>
            </Show>
          </div>
        )}
      </Show>
    </section>
  );
}

/**
 * MyPokoin → Pricer: the seller's pricing groups, each priced by one
 * strategy, and (view=strategies) the strategy editor.
 */
export default function PricerTab(props) {
  const pricing = props.pricing;
  const [params, setParams] = useSearchParams();
  const view = () => (params.view === 'strategies' ? 'strategies' : 'groups');
  const showView = (next) => setParams({ view: next === 'strategies' ? 'strategies' : undefined });
  const [picked, setPicked] = createSignal('');
  const [creating, setCreating] = createSignal(false);
  const group = createMemo(() => {
    const list = pricing.groups();
    return list.find((entry) => entry.id === picked()) || list[0] || null;
  });
  // A dry run answers for one group, strategy and change (`version`). A plan
  // for another key is never shown: a change hides the old plan in the same
  // flush, without an effect writing it away afterwards.
  const planKey = createMemo(() => {
    const current = group();
    return current ? `${current.strategyId}|${pricing.version()}|${current.id}` : '';
  });
  const [planState, setPlanState] = createSignal(null);
  const planOf = (field) => {
    const state = planState();
    return state && state.key === planKey() ? state[field] : null;
  };
  const plan = () => planOf('answer');
  const planError = () => planOf('error') || '';
  const strategyName = (id) => pricing.strategies().find((entry) => entry.id === id)?.name || 'No strategy';
  const ungrouped = () => ungroupedCount(props.rows || [], pricing.memberships());
  // The editor's worked example: the selected group's first card with offers per toggle.
  const exampleComp = createMemo(() => {
    const groupId = group()?.id;
    const members = (props.rows || []).filter((row) => groupId && pricing.memberships().get(String(row.id)) === groupId);
    return pickExampleComp(members.map((row) => pricing.compFor(row)));
  });
  const boardHref = () => (props.preview ? '/mypokoin?mypokoinPreview' : '/mypokoin');

  // The selected group's dry run, again after every change to the groups.
  // Also behind the Strategies view: its worked example uses the group's first comp.
  // A preview apply rewrites the fixture rows and bumps `version` with them.
  createEffect(
    () => ({ key: planKey(), groupId: group()?.id || '' }),
    ({ key, groupId }) => {
      if (!key) return undefined;
      let cancelled = false;
      pricing.apply({ groupId, dryRun: true })
        .then((answer) => !cancelled && setPlanState({ key, answer, error: '' }))
        .catch((err) => !cancelled && setPlanState({ key, answer: null, error: err.message || 'Could not check the prices for this group.' }));
      return () => { cancelled = true; };
    },
  );

  async function create(input) {
    const answer = await pricing.saveGroup({ group: input });
    setPicked(answer.groupId);
    setCreating(false);
  }

  return (
    <Switch>
      <Match when={view() === 'strategies'}>
        <StrategiesPanel
          pricing={pricing}
          exampleComp={exampleComp()}
          onBack={() => showView('groups')}
        />
      </Match>
      <Match when={true}>
        <div class="pricer-tab">
          <div class="mypokoin-panel-head">
            <div>
              <h2>Pricing groups</h2>
              <p class="mypokoin-help">Pick cards on the Listings board into a group. Each group is priced by one strategy.</p>
            </div>
            <div class="pricer-head-actions">
              <button type="button" class="btn ghost" onClick={() => showView('strategies')}>
                Strategies ({pricing.strategies().length})
              </button>
              <button
                type="button"
                class="btn"
                disabled={!pricing.strategies().length}
                aria-expanded={String(creating())}
                onClick={() => setCreating(!creating())}
              >
                New group
              </button>
            </div>
          </div>
          <Alert>{pricing.error()}</Alert>

          <Show when={creating() && pricing.strategies().length}>
            <section class="mypokoin-card">
              <NewGroupForm
                daily
                groups={pricing.groups()}
                strategies={pricing.strategies()}
                onCreate={create}
                onCancel={() => setCreating(false)}
              />
            </section>
          </Show>

          <Switch>
            <Match when={!pricing.loaded()}>
              <div class="mypokoin-card"><div class="skeleton-line" /><div class="skeleton-line" /></div>
            </Match>
            <Match when={!pricing.strategies().length}>
              <section class="mypokoin-card pricer-empty">
                <strong>Make a strategy first</strong>
                <p class="mypokoin-help">
                  A strategy is a named rule for how to price, like “undercut CardTrader by 5%, never below {pkn(1, pricing.currencyCtx())}”.
                  Every group is priced by one.
                </p>
                <button type="button" class="btn" onClick={() => showView('strategies')}>Open Strategies</button>
              </section>
            </Match>
            <Match when={!pricing.groups().length}>
              <section class="mypokoin-card pricer-empty">
                <strong>No pricing groups yet</strong>
                <p class="mypokoin-help">
                  Tick cards on the Listings board and choose “Add to group ▾”, or make an empty group with “New group”
                  and fill it from the board. Cards in no group are never repriced.
                </p>
                <div class="pricer-form-actions">
                  <a class="btn" href={boardHref()}>Open Listings</a>
                  <button type="button" class="btn ghost" onClick={() => setCreating(true)}>New group</button>
                </div>
              </section>
            </Match>
            <Match when={group()}>
              {(selected) => (
                <div class="pricer-cols">
                  <div class="pricer-side">
                    <ul class="pricer-group-list" aria-label="Groups">
                      <For each={pricing.groups()} keyed={(entry) => entry.id}>
                        {(entry) => (
                          <li>
                            <button
                              type="button"
                              class={['pricer-group-item', { on: entry().id === selected().id }]}
                              aria-pressed={String(entry().id === selected().id)}
                              onClick={() => setPicked(entry().id)}
                            >
                              <span class="pricer-group-top">
                                <strong>{entry().name}</strong>
                                <Show when={entry().autoDaily}><span class="pricer-badge">Daily</span></Show>
                              </span>
                              <span class="pricer-group-sub">{cardsLabel(Number(entry().listingCount) || 0)} · {strategyName(entry().strategyId)}</span>
                              <span class="pricer-group-sub">{lastAppliedLine(entry())}</span>
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                    <p class="pricer-note">
                      {ungrouped()} {ungrouped() === 1 ? 'listing is' : 'listings are'} in no group and {ungrouped() === 1 ? 'is' : 'are'} never repriced.
                    </p>
                  </div>
                  {/* One panel per group: another group starts clean (checks, confirm, results). */}
                  <Show when={selected().id} keyed>
                    {() => (
                      <GroupPanel
                        pricing={pricing}
                        group={selected()}
                        rows={props.rows}
                        plan={plan()}
                        planError={planError()}
                        boardHref={boardHref()}
                        onApplied={props.onApplied}
                      />
                    )}
                  </Show>
                </div>
              )}
            </Match>
          </Switch>
        </div>
      </Match>
    </Switch>
  );
}
