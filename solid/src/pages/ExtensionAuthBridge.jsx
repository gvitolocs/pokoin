import { createEffect, createSignal, Match, onSettled, Switch } from 'solid-js';
import { extensionAuthTokenPayload, isExtensionAuthRequest } from '@market/extension-auth-bridge.js';
import { authFrom } from '@market/punchouts.js';
import AuthLink from '../components/AuthLink.jsx';
import { authConfirmed, authUser, loadAuth } from '../stores/auth.js';

/**
 * /extension/auth-bridge: the
 * Chrome extension opens this bare page and listens for the Firebase ID
 * token this origin posts to itself (only a Firebase user, never a desk
 * session, can mint one).
 */
export default function ExtensionAuthBridge() {
  const [status, setStatus] = createSignal('waiting');
  document.title = 'Extension auth · Pokoin';
  loadAuth().catch(() => {});

  async function postToken() {
    const user = authUser();
    if (!user) return;
    try {
      const result = await user.getIdTokenResult();
      const payload = extensionAuthTokenPayload(user, result.token, {
        expirationTime: result.expirationTime,
      });
      if (!payload) {
        setStatus('missing');
        return;
      }
      window.postMessage(payload, window.location.origin);
      setStatus('sent');
    } catch (_) {
      setStatus('error');
    }
  }

  createEffect(
    () => (authConfirmed() ? (authUser() ? authUser().uid : '') : null),
    (uid) => {
      if (uid === null) return;
      if (uid) postToken();
      else setStatus('signed-out');
    },
  );

  onSettled(() => {
    function onMessage(event) {
      if (event.origin !== window.location.origin || event.source !== window) return;
      if (!isExtensionAuthRequest(event.data) || !authUser()) return;
      postToken();
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });

  return (
    <div class="page desk">
      <main class="desk-panel" style={{ 'max-width': `${28 * 16}px`, margin: '2rem auto' }}>
        <div class="desk-body">
          <p>Chrome extension sign-in bridge.</p>
          <Switch>
            <Match when={!authConfirmed()}><p>Checking Pokoin session…</p></Match>
            <Match when={authUser()}>
              <p>{status() === 'sent' ? 'Token sent to the extension.' : 'Sending token…'}</p>
            </Match>
            <Match when={true}>
              <p>
                <AuthLink class="btn" to={authFrom('/extension/auth-bridge')}>Sign in</AuthLink>
              </p>
            </Match>
          </Switch>
        </div>
      </main>
    </div>
  );
}
