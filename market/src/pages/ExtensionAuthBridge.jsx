import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import {
  extensionAuthTokenPayload,
  isExtensionAuthRequest,
} from '../extension-auth-bridge.js';
import { authFrom } from '../punchouts.js';

export default function ExtensionAuthBridge() {
  const { user, ready, signedIn } = useAuth();
  const [status, setStatus] = useState('waiting');

  const postToken = useCallback(async () => {
    if (!user) {
      return;
    }
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
  }, [user]);

  useEffect(() => {
    document.title = 'Extension auth · Pokoin';
  }, []);

  useEffect(() => {
    if (!ready) {
      return;
    }
    if (signedIn) {
      postToken();
      return;
    }
    setStatus('signed-out');
  }, [ready, signedIn, postToken]);

  useEffect(() => {
    function onMessage(event) {
      if (event.origin !== window.location.origin || event.source !== window) {
        return;
      }
      if (!isExtensionAuthRequest(event.data) || !user) {
        return;
      }
      postToken();
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [user, postToken]);

  return (
    <div className="page desk">
      <main className="desk-panel" style={{ maxWidth: 28 * 16, margin: '2rem auto' }}>
        <div className="desk-body">
          <p>Chrome extension sign-in bridge.</p>
          {!ready ? <p>Checking Pokoin session…</p> : null}
          {ready && signedIn ? (
            <p>{status === 'sent' ? 'Token sent to the extension.' : 'Sending token…'}</p>
          ) : null}
          {ready && !signedIn ? (
            <p>
              <Link className="btn" to={authFrom('/extension/auth-bridge')}>Sign in</Link>
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
