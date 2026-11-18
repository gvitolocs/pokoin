import { Match, Switch } from 'solid-js';
import { stackOrder } from '@market/price-stack.js';

/**
 * Buyer price, local fiat over PKN. props.flip puts the local amount on the large
 * line and PKN on the small one (Best Deal); a single price is unchanged.
 */
export default function PriceStack(props) {
  const local = () => props.parts?.local || '';
  const pkn = () => props.parts?.pkn || '';
  const small = () => (stackOrder(props.parts, props.flip)?.[0] === 'pkn' ? pkn() : local());
  const large = () => (stackOrder(props.parts, props.flip)?.[1] === 'local' ? local() : pkn());
  return (
    <Switch fallback={(
      <span class="px-stack">
        <span class="px-local">{small()}</span>
        <span class="px-pkn">{large()}</span>
      </span>
    )}
    >
      <Match when={props.parts?.pending}><span class="px-pending" aria-hidden="true" /></Match>
      <Match when={!local()}>{pkn() || props.fallback || '—'}</Match>
      <Match when={!pkn()}><span class="px-stack"><span class="px-local is-solo">{local()}</span></span></Match>
    </Switch>
  );
}
