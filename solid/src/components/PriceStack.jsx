import { Match, Switch } from 'solid-js';

/** Buyer price, local fiat over PKN (market/src/components/PriceStack.jsx). */
export default function PriceStack(props) {
  const local = () => props.parts?.local || '';
  const pkn = () => props.parts?.pkn || '';
  return (
    <Switch fallback={(
      <span class="px-stack">
        <span class="px-local">{local()}</span>
        <span class="px-pkn">{pkn()}</span>
      </span>
    )}
    >
      <Match when={props.parts?.pending}><span class="px-pending" aria-hidden="true" /></Match>
      <Match when={!local()}>{pkn() || props.fallback || '—'}</Match>
      <Match when={!pkn()}><span class="px-stack"><span class="px-local is-solo">{local()}</span></span></Match>
    </Switch>
  );
}
