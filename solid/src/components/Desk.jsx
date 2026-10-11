import { children, For, Show } from 'solid-js';
import { flagSrc } from '@market/locale.js';

/**
 * Desk building blocks (market/src/components/Desk.jsx): same markup and
 * classes, so market/src/styles.css applies unchanged. Slots that React took
 * as elements (`leading`, `meta`, `extra`, `actions`) are passed the same way;
 * each slot is resolved once (`children`) so testing it does not build it twice.
 */
export function PageHead(props) {
  const leading = children(() => props.leading);
  const meta = children(() => props.meta);
  const lede = children(() => props.lede);
  const actions = children(() => props.children);
  const text = (
    <div>
      <Show when={props.kicker}><p class="page-kicker">{props.kicker}</p></Show>
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
      <Show when={lede()}><p class="page-lede">{lede()}</p></Show>
    </div>
  );
  return (
    <header class="page-head">
      <Show when={leading()} fallback={text}>
        <div class="page-head-identity">{leading()}{text}</div>
      </Show>
      <Show when={actions()}><div class="page-actions">{actions()}</div></Show>
    </header>
  );
}

export function Metric(props) {
  const hint = children(() => props.hint);
  return (
    <div class="metric">
      <strong class="metric-value">{props.value}</strong>
      <span class="metric-label">{props.label}</span>
      <Show when={hint()}><span class="metric-hint">{hint()}</span></Show>
    </div>
  );
}

export function MetricGrid(props) {
  return <div class="metric-grid">{props.children}</div>;
}

export function DeskPanel(props) {
  const title = children(() => props.title);
  const extra = children(() => props.extra);
  const actions = children(() => props.actions);
  return (
    <section class={['desk-panel', props.class, { flush: Boolean(props.flush) }]}>
      <Show when={title() || extra()}>
        <div class="desk-panel-head">
          <Show when={title()} fallback={<span />}><h2>{title()}</h2></Show>
          {extra()}
        </div>
      </Show>
      <div class="desk-body">{props.children}</div>
      <Show when={actions()}><div class="desk-actions">{actions()}</div></Show>
    </section>
  );
}

const EMPTY_ICON = {
  mark: 'M7 3h10a2 2 0 0 1 2 2v14l-7-3-7 3V5a2 2 0 0 1 2-2zm0 2v11.2l5-2.1 5 2.1V5H7z',
  cart: 'M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1 1 0 0 0 20 4H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z',
};

export function EmptyDesk(props) {
  const cta = children(() => props.children);
  const lede = children(() => props.lede);
  return (
    <div class={props.nested ? 'empty-desk nested' : 'empty-desk'}>
      <div class="empty-art" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="28" height="28">
          <path fill="currentColor" d={EMPTY_ICON[props.icon] || EMPTY_ICON.mark} />
        </svg>
      </div>
      <p class="empty-title">{props.title}</p>
      <Show when={lede()}><p class="empty-lede">{lede()}</p></Show>
      <Show when={cta()}><div class="empty-cta">{cta()}</div></Show>
    </div>
  );
}

/** Status line; renders nothing when empty. Text as children or `message` (browse port's API). */
export function Alert(props) {
  const text = children(() => props.message ?? props.children);
  return (
    <Show when={text()}>
      <p class="desk-alert" role="status">{text()}</p>
    </Show>
  );
}

export function SkeletonThreads(props) {
  return (
    <div class="skeleton-thread" aria-hidden="true">
      <For each={Array.from({ length: props.rows ?? 4 })}>
        {() => (
          <div class="skeleton-row">
            <span class="skeleton-line" />
            <span class="skeleton-line short" />
          </div>
        )}
      </For>
    </div>
  );
}

export function SessionWait() {
  return (
    <div class="page desk">
      <SkeletonThreads rows={3} />
    </div>
  );
}

export function Thread(props) {
  const meta = children(() => props.meta);
  const inner = () => (
    <>
      <span class="thread-main">
        <strong class="thread-title">{props.title}</strong>
        <Show when={meta()}><span class="thread-meta">{meta()}</span></Show>
        {props.children}
      </span>
      <svg class="thread-chevron" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path fill="currentColor" d="M9.3 6.3 8 7.6 12.6 12 8 16.4l1.3 1.3 6-5.7z" />
      </svg>
    </>
  );
  return (
    <Show when={props.to} fallback={<article class="thread">{inner()}</article>}>
      <a class="thread" href={props.to}>{inner()}</a>
    </Show>
  );
}

export function FilePill(props) {
  return (
    <label class="file-pill">
      <input
        type="file"
        accept={props.accept}
        multiple={props.multiple}
        disabled={props.disabled}
        onChange={(event) => props.onChange?.(event)}
      />
      <span>{props.children}</span>
    </label>
  );
}
