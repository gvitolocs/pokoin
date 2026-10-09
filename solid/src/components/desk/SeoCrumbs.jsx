import { For, Show } from 'solid-js';

/** Breadcrumb trail (market/src/components/SeoCrumbs.jsx). */
export default function SeoCrumbs(props) {
  const crumbs = () => (props.items || []).filter((item) => item && item.name);
  return (
    <Show when={crumbs().length}>
      <nav class="crumbs" aria-label="Breadcrumb">
        <For each={crumbs()}>
          {(item, index) => {
            const last = () => index() === crumbs().length - 1;
            return (
              <span>
                <Show when={index()}><span class="sep">/</span></Show>
                <Show when={!last() && item.href} fallback={<span class={last() ? 'here' : undefined}>{item.name}</span>}>
                  <a href={item.href}>{item.name}</a>
                </Show>
              </span>
            );
          }}
        </For>
      </nav>
    </Show>
  );
}
