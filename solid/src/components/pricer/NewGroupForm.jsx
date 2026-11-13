import { createSignal, For, Show } from 'solid-js';
import { localizeStrategyName, nameProblem } from '@market/pricer.js';

/**
 * Name + strategy (+ daily) for a new pricing group: the Pricer tab's
 * "New group" and the board's "Add to group ▾" mini-form. `onCreate`
 * resolves when the group exists; a rejection shows its message here.
 * `ctx` is the seller's currency context for the strategy names.
 */
export default function NewGroupForm(props) {
  const [name, setName] = createSignal('');
  const [strategyId, setStrategyId] = createSignal(() => props.strategies?.[0]?.id || '');
  const [autoDaily, setAutoDaily] = createSignal(false);
  const [touched, setTouched] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const problem = () => nameProblem(name(), '', props.groups || [], 'group');
  const idPrefix = props.idPrefix || 'pricer-new-group';
  // Without a currency context the saved text stays as it is.
  const optionText = (entry) => (props.ctx ? localizeStrategyName(entry.name, props.ctx) : entry.name);

  async function submit(event) {
    event.preventDefault();
    setTouched(true);
    if (problem() || !strategyId() || busy()) return;
    setBusy(true);
    setError('');
    try {
      await props.onCreate({ name: name().trim(), strategyId: strategyId(), autoDaily: autoDaily() });
      setName('');
      setTouched(false);
    } catch (err) {
      setError(err.message || 'Could not create the group.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class={['pricer-new-group', props.class]} onSubmit={submit} aria-label="New group">
      <label class="ps-field">
        <span>Group name</span>
        <input
          id={`${idPrefix}-name`}
          value={name()}
          maxLength={80}
          placeholder="Group name"
          autocomplete="off"
          onInput={(event) => setName(event.target.value)}
          onBlur={() => name() && setTouched(true)}
        />
      </label>
      <label class="ps-field">
        <span>Strategy</span>
        <select value={strategyId()} onChange={(event) => setStrategyId(event.target.value)} aria-label="Strategy for the new group">
          <For each={props.strategies || []}>{(entry) => <option value={entry.id}>{optionText(entry)}</option>}</For>
        </select>
      </label>
      <Show when={props.daily}>
        <label class="ps-field ps-check">
          <input type="checkbox" checked={autoDaily()} onChange={(event) => setAutoDaily(event.target.checked)} />
          <span>Reprice every day</span>
        </label>
      </Show>
      <div class="pricer-form-actions">
        <button type="submit" class="btn" disabled={busy() || !props.strategies?.length}>
          {busy() ? 'Creating…' : (props.submitLabel || 'Create')}
        </button>
        <Show when={props.onCancel}>
          <button type="button" class="btn ghost" onClick={() => props.onCancel()}>Cancel</button>
        </Show>
      </div>
      <Show when={touched() && problem()}><p class="pricer-field-error" role="alert">{problem()}</p></Show>
      <Show when={error()}><p class="pricer-field-error" role="alert">{error()}</p></Show>
    </form>
  );
}
