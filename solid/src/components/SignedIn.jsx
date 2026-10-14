import { children, createEffect, createMemo, Match, Switch } from 'solid-js';
import { useLocation, useNavigate } from '@solidjs/router';
import { authFrom } from '@market/punchouts.js';
import { authConfirmed, loadAuth, signedIn } from '../stores/auth.js';
import { SessionWait } from './Desk.jsx';

/**
 * The account-page gate every React page spelled out by hand:
 * `if (!ready) return <SessionWait />; if (!signedIn) return <Navigate to={authFrom(path)} replace />`.
 * Firebase Auth loads here (account pages need its answer, not the cached
 * session); `wait` replaces the skeleton, `from` the return path. `early`
 * paints on the cached session hint before Firebase answers (React pages that
 * wrote `if (!ready && !signedIn) return <SessionWait />`).
 */
export default function SignedIn(props) {
  const navigate = useNavigate();
  const location = useLocation();
  loadAuth().catch(() => {});
  const state = createMemo(() => {
    if (!authConfirmed()) return props.early && signedIn() ? 'in' : 'wait';
    return signedIn() ? 'in' : 'out';
  });
  createEffect(
    () => (state() === 'out' ? authFrom(props.from || location.pathname || '/marketplace') : ''),
    (target) => {
      if (target) navigate(target, { replace: true });
    },
  );
  const wait = children(() => props.wait);
  return (
    <Switch>
      <Match when={state() === 'wait'}>{wait() ?? <SessionWait />}</Match>
      <Match when={state() === 'in'}>{props.children}</Match>
    </Switch>
  );
}
