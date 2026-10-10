import { children, Show } from 'solid-js';
import { flagSrc } from '@market/locale.js';

/**
 * Desk page chrome (market/src/components/Desk.jsx): same markup and classes.
 * `title`, `kicker` and `leading` may be JSX. Like React, the actions block
 * is rendered whenever children are passed, even if they render nothing.
 */
export function PageHead(props) {
  const hasActions = 'children' in props;
  // JSX-valued slots resolve once: a getter read twice (Show test + body)
  // would build the node twice.
  const kicker = children(() => props.kicker);
  const meta = children(() => props.meta);
  const leading = children(() => props.leading);
  const text = () => (
    <div>
      <Show when={kicker()}><p class="page-kicker">{kicker()}</p></Show>
      <h1 class={props.printFlag ? 'page-title has-print-flag' : 'page-title'}>
        <Show when={props.printFlag}>
          <span class="page-print-flag">
            <img src={flagSrc(props.printFlag.code)} alt="" width="44" height="44" />
            <span class="sr-only">{props.printFlag.label}</span>
          </span>
        </Show>
        {props.title}
      </h1>
      <Show when={meta()}><div class="page-meta">{meta()}</div></Show>
      <Show when={props.lede}><p class="page-lede">{props.lede}</p></Show>
    </div>
  );
  return (
    <header class="page-head">
      <Show when={leading()} fallback={text()}>
        <div class="page-head-identity">{leading()}{text()}</div>
      </Show>
      <Show when={hasActions}><div class="page-actions">{props.children}</div></Show>
    </header>
  );
}

export function Metric(props) {
  return (
    <div class="metric">
      <strong class="metric-value">{props.value}</strong>
      <span class="metric-label">{props.label}</span>
      <Show when={props.hint}><span class="metric-hint">{props.hint}</span></Show>
    </div>
  );
}

export function MetricGrid(props) {
  return <div class="metric-grid">{props.children}</div>;
}

const EMPTY_ICON = {
  mark: 'M7 3h10a2 2 0 0 1 2 2v14l-7-3-7 3V5a2 2 0 0 1 2-2zm0 2v11.2l5-2.1 5 2.1V5H7z',
  cart: 'M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1 1 0 0 0 20 4H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z',
};

export function EmptyDesk(props) {
  const hasCta = 'children' in props;
  return (
    <div class={props.nested ? 'empty-desk nested' : 'empty-desk'}>
      <div class="empty-art" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="28" height="28">
          <path fill="currentColor" d={EMPTY_ICON[props.icon || 'mark'] || EMPTY_ICON.mark} />
        </svg>
      </div>
      <p class="empty-title">{props.title}</p>
      <Show when={props.lede}><p class="empty-lede">{props.lede}</p></Show>
      <Show when={hasCta}><div class="empty-cta">{props.children}</div></Show>
    </div>
  );
}

/** Status line; renders nothing for an empty message (pass the text as `message`). */
export function Alert(props) {
  return (
    <Show when={props.message}>
      <p class="desk-alert" role="status">{props.message}</p>
    </Show>
  );
}
