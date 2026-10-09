import { createEffect, Errored, Loading, onSettled } from 'solid-js';
import Chrome from './components/Chrome.jsx';
import { signedIn, warmAuthWhenIdle } from './stores/auth.js';
import { ensureSellerSettings } from './stores/buyer.js';

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

/**
 * Root layout: the header stays mounted across navigations; only the route
 * content swaps. Loading covers a route chunk / first data read; once a page
 * has rendered, revalidation keeps it visible (no spinner flash on back/forward).
 */
export default function App(props) {
  // Firebase Auth after the first paint; buyer currency once a session exists.
  onSettled(() => warmAuthWhenIdle());
  createEffect(() => signedIn(), (on) => {
    if (on) ensureSellerSettings();
  });
  return (
    <Chrome>
      <Errored fallback={(err, reset) => <RouteError error={err()} reset={reset} />}>
        <Loading fallback={<RoutePending />}>{props.children}</Loading>
      </Errored>
    </Chrome>
  );
}
