import { createSignal, For, onSettled, Show, untrack } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { probeRpc, sitePage } from '@market/site-pages.js';
import { DeskPanel, PageHead } from '../components/Desk.jsx';

/** One static page; remounted per path so the /health probe never shows on another page. */
function SitePage(props) {
  const path = untrack(() => props.path);
  const { page } = sitePage(path);
  const [rpc, setRpc] = createSignal(path === '/health' ? 'Checking RPC…' : '');
  let disposed = false;

  document.title = `${page.title} · Pokoin`;
  if (path === '/health') {
    probeRpc().then((status) => {
      if (!disposed) setRpc(status);
    });
  }
  onSettled(() => () => {
    disposed = true;
  });

  return (
    <div class="page desk">
      <PageHead kicker={page.eyebrow} title={page.title} lede={page.lead} />
      <Show when={rpc()}><p class="desk-ok">{rpc()}</p></Show>
      <For each={page.body}>
        {([heading, copy]) => (
          <DeskPanel title={heading}>
            <p class="page-lede">{copy}</p>
          </DeskPanel>
        )}
      </For>
      <p class="page-lede">
        <a href="/marketplace">Marketplace</a>
        {' · '}
        <a href="/docs">Docs</a>
        {' · '}
        <a href="/wallet">Wallet</a>
        {' · '}
        <a href="https://explorer.pokoin.com">Explorer</a>
      </p>
    </div>
  );
}

/** /docs, /contact, /privacy, /earn, /whitepaper, /health (market/src/pages/Site.jsx). */
export default function Site() {
  const location = useLocation();
  return (
    <Show when={sitePage(location.pathname).path} keyed>
      {(path) => <SitePage path={path} />}
    </Show>
  );
}
