import { createEffect, createSignal, Errored, getOwner, Loading, onSettled, runWithOwner, Show, untrack } from 'solid-js';
import { useLocation, useNavigate } from '@solidjs/router';
import { framedByChromeExtension } from '@market/extension-auth-bridge.js';
import { gameBasename } from '@market/game.js';
import { isGamePrivatePath } from '@market/game-private-path.js';
import { legacyDashboardHref } from '@market/punchouts.js';
import { isDashboardHost } from '@market/scan-api.js';
import { subscribeOriginDown } from '@market/working-page.js';
import Chrome from './components/Chrome.jsx';
import CookieBanner from './components/CookieBanner.jsx';
import WorkingOnIt from './components/WorkingOnIt.jsx';
import { isBarePath } from './lib/bare-pages.js';
import { chatDock } from './lib/chat-dock-loader.js';
import { whenIdle } from './lib/idle.js';
import { warmLikelyRoutes } from './lib/route-warmup.js';
import { setLinkNavigator } from './lib/yield-nav.js';
import { reportClientError } from './lib/client-error.js';
import { refreshAccount, watchAccount } from './stores/account.js';
import { signedIn, warmAuthWhenIdle, watchDeskSession } from './stores/auth.js';
import { ensureSellerSettings } from './stores/buyer.js';
import { startCartSync } from './stores/cart.js';

/** Same placeholder as the React RouteSuspense: keeps the desk shell, no CLS. */
function RoutePending() {
  return <div class="page desk" style={{ 'min-height': '55vh' }} role="status" aria-busy="true" />;
}

function RouteError(props) {
  reportClientError(props.error, signedIn());
  const detail = String(props.error?.message || props.error || '').slice(0, 200);
  return (
    <div class="page desk" style={{ padding: '2.5rem 1.25rem' }} role="alert">
      <p>Something went wrong loading this page.</p>
      <Show when={detail}>
        <p style={{ color: 'var(--muted)', 'font-size': '0.8rem' }}>{detail}</p>
      </Show>
      <button type="button" class="btn" onClick={() => props.reset()}>Try again</button>
    </div>
  );
}

/** Leave this host or game prefix for the same page elsewhere (React DashboardMarketHandoff). */
function DashboardMarketHandoff(props) {
  onSettled(() => {
    window.location.replace(props.target);
  });
  return (
    <div class="page desk" style={{ padding: '2.5rem 1.25rem', color: 'var(--muted)' }} role="status">
      Opening Pokoin…
    </div>
  );
}

/**
 * Root layout (market/src/App.jsx AppShell): the header stays mounted across
 * navigations; only the route content swaps. Loading covers a route chunk /
 * first data read; once a page has rendered, revalidation keeps it visible.
 * Shell extras: the cookie notice, invite-code claims, the origin-down page,
 * and the chat dock — its own chunk, loaded when the page goes idle.
 */
export default function App(props) {
  setLinkNavigator(useNavigate());
  const location = useLocation();
  const framed = framedByChromeExtension();
  const [originDown, setOriginDown] = createSignal(typeof window !== 'undefined' && Boolean(window.__pokoinOriginDown));

  const owner = getOwner();
  // Firebase Auth after the first paint; buyer currency once a session exists.
  // Idle: the chat dock, invite-code claims, the account cart sync and the
  // Google reviews badge — none of them is on the first paint.
  onSettled(() => {
    // React legacy tripwire (scripts/build-ui-shell.mjs): the boot script names
    // whatever would once have picked the React UI; report it so the console,
    // test crawls and the API journal show where React is still referenced.
    const legacy = window.__POKOIN_REACT_LEGACY__;
    if (legacy) reportClientError(new Error(`[react-legacy] ${legacy} ${location.pathname}`));
    warmAuthWhenIdle();
    const stopDeskSession = watchDeskSession(() => refreshAccount());
    const unsubscribe = subscribeOriginDown(() => setOriginDown(true));
    document.documentElement.classList.toggle('is-extension-desk', framed);
    const cancelIdle = whenIdle(() => {
      warmLikelyRoutes();
      chatDock.warm();
      startCartSync();
      import('./lib/referral-claim.js')
        .then(({ watchReferralClaims }) => runWithOwner(owner, () => watchReferralClaims(location)))
        .catch(() => {});
      import('@market/google-reviews.js').then(({ showReviewsBadge }) => showReviewsBadge()).catch(() => {});
    });
    return () => {
      stopDeskSession();
      unsubscribe();
      cancelIdle();
      document.documentElement.classList.remove('is-extension-desk');
    };
  });
  createEffect(() => signedIn(), (on) => {
    if (on) ensureSellerSettings();
  });
  watchAccount();

  // Test boards and the extension sign-in bridge are bare pages (a React
  // "board"): no header, no origin-down page, and they stay on the legacy
  // dashboard host.
  const bare = () => isBarePath(location.pathname);
  // Account and site pages live on the Pokemon apex: /one-piece/wallet reloads
  // as /wallet (React AppShell). The router keeps the game prefix in pathname.
  const gameBase = gameBasename();
  const routerPath = () => location.pathname.slice(gameBase.length) || '/';
  const gamePrivate = () => Boolean(gameBase) && isGamePrivatePath(routerPath());
  const route = () => (
    <Errored fallback={(err, reset) => <RouteError error={err()} reset={reset} />}>
      <Loading fallback={<RoutePending />}>{props.children}</Loading>
    </Errored>
  );

  if (isDashboardHost() && !untrack(bare)) {
    return <DashboardMarketHandoff target={untrack(() => legacyDashboardHref(location.pathname, location.search))} />;
  }

  return (
    <Show when={!gamePrivate()} fallback={<DashboardMarketHandoff target={`${routerPath()}${location.search || ''}`} />}>
    <Show when={!bare()} fallback={route()}>
      <Show when={!(originDown() && !framed)} fallback={<WorkingOnIt />}>
        <Chrome>{route()}</Chrome>
        <CookieBanner />
        <Show when={chatDock.mod()}>
          {(mod) => {
            const Dock = untrack(mod).default;
            return <Dock />;
          }}
        </Show>
      </Show>
    </Show>
    </Show>
  );
}
