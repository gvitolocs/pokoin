import { createEffect, Match, Switch } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { authFrom } from '@market/punchouts.js';
import { SessionWait } from '../../components/Desk.jsx';
import { authReady, signedIn } from '../../stores/auth.js';

/**
 * React's `if (!ready) <SessionWait />; if (!signedIn) <Navigate to={authFrom(path)} replace />`
 * guard: children mount only for a signed-in member.
 */
export function RequireSignIn(props) {
  const navigate = useNavigate();
  createEffect(
    () => authReady() && !signedIn(),
    (out) => {
      if (out) navigate(authFrom(props.from), { replace: true });
    },
  );
  return (
    <Switch>
      <Match when={!authReady()}><SessionWait /></Match>
      <Match when={signedIn()}>{props.children}</Match>
    </Switch>
  );
}
