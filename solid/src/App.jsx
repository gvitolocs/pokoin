import { createEffect, createSignal, Errored, getOwner, Loading, onSettled, runWithOwner, Show, untrack } from 'solid-js';
import { useLocation, useNavigate } from '@solidjs/router';
import { framedByChromeExtension } from '@market/extension-auth-bridge.js';
import { legacyDashboardHref } from '@market/punchouts.js';
import { isDashboardHost } from '@market/scan-api.js';
import { subscribeOriginDown } from '@market/working-page.js';
import Chrome from './components/Chrome.jsx';
import CookieBanner from './components/CookieBanner.jsx';
import WorkingOnIt from './components/WorkingOnIt.jsx';
import { chatDock } from './lib/chat-dock-loader.js';
import { whenIdle } from './lib/idle.js';
import { warmLikelyRoutes } from './lib/route-warmup.js';
import { setLinkNavigator } from './lib/yield-nav.js';
import { watchAccount } from './stores/account.js';
import { signedIn, warmAuthWhenIdle } from './stores/auth.js';
import { ensureSellerSettings } from './stores/buyer.js';
import { startCartSync } from './stores/cart.js';

/** Same placeholder as the React RouteSuspense: keeps the desk shell, no CLS. */
function RoutePending() {
  return <div class="page desk" style={{ 'min-height': '55vh' }} role="status" aria-busy="true" />;
}

function RouteError(props) {
  return (
    <div class="page desk" style={{ padding: '2.5rem 1.25rem' }} role="alert">
      <p>Something went wrong loading this page.</p>
      <button type="button" class="btn" onClick={() => props.reset()}>Try again</button>
    </div>
  );
}

/** Leave dashboard.pokoin.com for the same path on pokoin.com (React DashboardMarketHandoff). */
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
    warmAuthWhenIdle();
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
      unsubscribe();
      cancelIdle();
      document.documentElement.classList.remove('is-extension-desk');
    };
  });
  createEffect(() => signedIn(), (on) => {
    if (on) ensureSellerSettings();
  });
  watchAccount();

  if (isDashboardHost()) {
    return <DashboardMarketHandoff target={untrack(() => legacyDashboardHref(location.pathname, location.search))} />;
  }

  return (
    <Show when={!(originDown() && !framed)} fallback={<WorkingOnIt />}>
      <Chrome>
        <Errored fallback={(err, reset) => <RouteError error={err()} reset={reset} />}>
          <Loading fallback={<RoutePending />}>{props.children}</Loading>
        </Errored>
      </Chrome>
      <CookieBanner />
      <Show when={chatDock.mod()}>
        {(mod) => {
          const Dock = untrack(mod).default;
          return <Dock />;
        }}
      </Show>
    </Show>
  );
}
