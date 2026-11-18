import { createEffect, For, Show, untrack } from 'solid-js';
import { localizeStrategyName, strategySummary } from '@market/pricer.js';
import { Alert } from '../Desk.jsx';
import StrategyEditor, { createStrategyEditor } from './StrategyEditor.jsx';
import { usedByLine } from './pricer-ui.js';

/**
 * Pricer → Strategies: the seller's named pricing rules and their editor.
 * A strategy says how to price, never which cards: groups pick one by name.
 * The form itself is `StrategyEditor`, which the listing drawer shows too.
 */
export default function StrategiesPanel(props) {
  const pricing = props.pricing;
  const ctx = () => pricing.currencyCtx();
  const editor = createStrategyEditor({
    strategy: untrack(() => pricing.strategies()[0] || null),
    ctx,
    strategies: () => pricing.strategies(),
    exampleComp: () => props.exampleComp,
    save: (draft) => pricing.saveStrategy(draft),
    remove: (id) => pricing.deleteStrategy(id),
    onBack: () => props.onBack?.(),
  });

  // Opened before the strategies arrived: show the first one once they do.
  createEffect(() => pricing.strategies()[0]?.id || '', (id) => {
    const current = untrack(editor.draft);
    if (id && !current.id && !current.name && !untrack(editor.touched)) editor.open(untrack(() => pricing.strategies()[0]));
  });

  return (
    <div class="pricer-tab pricer-strategies">
      <button type="button" class="pricer-back" onClick={() => editor.leaveTo('back')}>← Pricing groups</button>
      <div class="mypokoin-panel-head">
        <div>
          <h2>Strategies</h2>
          <p class="mypokoin-help">A strategy is a named rule for how to price. Groups and batch uploads pick one by name.</p>
        </div>
        <button type="button" class="btn" onClick={() => editor.leaveTo('new')}>New strategy</button>
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
                      class={['pricer-group-item', { on: entry().id === editor.selectedId() && entry().id === editor.draft().id }]}
                      aria-pressed={String(entry().id === editor.selectedId() && entry().id === editor.draft().id)}
                      onClick={() => (entry().id === editor.draft().id ? undefined : editor.leaveTo(entry()))}
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

        <StrategyEditor editor={editor} />
      </div>
    </div>
  );
}
