import { createEffect, createMemo, Match, Switch } from 'solid-js';
import { useLocation, useNavigate } from '@solidjs/router';
import { authFrom } from '@market/punchouts.js';
import { authUser, loadAuth, signedIn } from '../stores/auth.js';
import { SessionWait } from './Desk.jsx';

/**
 * The gate the React account pages spelled out by hand:
 * `if (!ready) return <SessionWait />; if (!signedIn) return <Navigate to={authFrom(path)} replace />`.
 * Firebase Auth loads here — these pages need its answer, not the cached
 * session. `from` overrides the return path (default: this pathname).
 */
export default function RequireSignIn(props) {
  const navigate = useNavigate();
  const location = useLocation();
  loadAuth().catch(() => {});
  const state = createMemo(() => (authUser() === undefined ? 'wait' : signedIn() ? 'in' : 'out'));
  createEffect(
    () => (state() === 'out' ? authFrom(props.from || location.pathname || '/marketplace') : ''),
    (target) => {
      if (target) navigate(target, { replace: true });
    },
  );
  return (
    <Switch>
      <Match when={state() === 'wait'}><SessionWait /></Match>
      <Match when={state() === 'in'}>{props.children}</Match>
    </Switch>
  );
}
