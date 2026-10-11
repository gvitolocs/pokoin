import { createEffect, createSignal, Match, onSettled, Show, Switch, untrack } from 'solid-js';
import { useLocation, useNavigate } from '@solidjs/router';
import { getJson } from '@market/api.js';
import { googleAuthPopupFailed, isAuthFramed, topLevelLoginUrl } from '@market/auth-google.js';
import {
  classifyVerifyError,
  isNativeVerifiedReturn,
  isPendingLoginError,
  RESEND_COOLDOWN_MS,
  resendCooldownRemainingMs,
  signupTokenFromSearch,
} from '@market/email-signup.js';
import {
  firebaseAuth,
  GoogleAuthProvider,
  getRedirectResult,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
} from '@market/firebase-signin.js';
import { isStaticSitePath } from '@market/punchouts.js';
import { Alert, PageHead } from '../components/Desk.jsx';
import { loadAuth } from '../stores/auth.js';

function requestVerificationEmail(payload) {
  return getJson('/api/register-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function verifySignupTokenRequest(token) {
  return getJson('/api/verify-email-signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

const TITLES = {
  signup: 'Create account · Pokoin',
  pending: 'Check your email · Pokoin',
  verifying: 'Verifying your email · Pokoin',
  login: 'Sign in · Pokoin',
};

/**
 * /auth (market/src/pages/Auth.jsx): email sign-in, email sign-up with a
 * verification link, Google (popup, redirect, or a top-level tab when framed
 * by the extension side panel). This page loads firebase/auth itself.
 */
export default function Auth() {
  const navigate = useNavigate();
  const location = useLocation();
  // The query is read once, as React's first render did.
  const search = untrack(() => location.search);
  const params = new URLSearchParams(search);
  const from = params.get('from') || '/profile';
  const safeFrom = from.startsWith('/') ? from : '/profile';
  // Pokoin News pages are static files outside the SPA: full page load there.
  const leave = (to) => {
    if (isStaticSitePath(to)) window.location.replace(to);
    else navigate(to, { replace: true });
  };
  const signupToken = signupTokenFromSearch(search);
  const verifiedReturn = isNativeVerifiedReturn(search);
  // /join/<code> sends new collectors straight to Create account. Native
  // Firebase action-code returns (?verified=1) land here as a plain sign-in.
  const [mode, setMode] = createSignal(params.get('mode') === 'signup' && !verifiedReturn ? 'signup' : 'login');
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [username, setUsername] = createSignal('');
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal(verifiedReturn ? 'Email verified. Sign in to continue.' : '');
  const [busy, setBusy] = createSignal(false);
  // PENDING_EMAIL_VERIFICATION screen state.
  const [pendingEmail, setPendingEmail] = createSignal('');
  const [resendReadyAt, setResendReadyAt] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());

  // Keep the shared auth store in step (header avatar, session hint).
  loadAuth().catch(() => {});

  createEffect(mode, (value) => {
    document.title = TITLES[value] || TITLES.login;
  });

  onSettled(() => {
    const el = document.createElement('meta');
    el.setAttribute('name', 'robots');
    el.setAttribute('data-pokoin-auth', '1');
    el.setAttribute('content', 'noindex, nofollow');
    document.head.querySelector('meta[name="robots"][data-pokoin-auth="1"]')?.remove();
    document.head.appendChild(el);

    let cancelled = false;
    let stop = () => {};
    // The pending/verification screens own this page; auto-redirecting an
    // already-signed-in user away from them would abandon a verification.
    if (!signupToken && !verifiedReturn) {
      getRedirectResult(firebaseAuth)
        .then((result) => {
          if (!cancelled && result?.user) leave(safeFrom);
        })
        .catch((err) => {
          if (!cancelled) setError(err.message || 'Google sign-in failed.');
        });
      stop = firebaseAuth.onAuthStateChanged((user) => {
        if (!cancelled && user) leave(safeFrom);
      });
    }
    // One token verifies once.
    if (signupToken) verifySignupToken(signupToken);
    return () => {
      cancelled = true;
      stop();
      el.remove();
    };
  });

  createEffect(
    () => mode() === 'pending',
    (pending) => {
      if (!pending) return undefined;
      const timer = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(timer);
    },
  );

  function enterPendingState(verifiedEmail) {
    setPendingEmail(verifiedEmail);
    setResendReadyAt(Date.now());
    setNow(Date.now());
    setError('');
    setNotice('');
    setMode('pending');
  }

  async function verifySignupToken(token) {
    setMode('verifying');
    setError('');
    try {
      const result = await verifySignupTokenRequest(token);
      // The account is ACTIVE on the server at this point; mint the session
      // from the custom token so the user lands inside the app signed in.
      await signInWithCustomToken(firebaseAuth, result.customToken);
      leave(result.redirectPath || safeFrom);
    } catch (err) {
      const classified = classifyVerifyError(err);
      setMode(classified.kind === 'expired' ? 'signup' : 'login');
      if (classified.kind === 'expired') {
        setNotice('This verification link expired. Create the account again to get a fresh link.');
      }
      setError(classified.message);
    }
  }

  async function onEmail(event) {
    event.preventDefault();
    const signup = mode() === 'signup';
    const address = email().trim();
    setBusy(true);
    setError('');
    try {
      if (signup) {
        // The Pokoin account stays pending until the emailed link is opened;
        // no Firebase identity exists until the backend verifies the token.
        await requestVerificationEmail({
          email: address,
          password: password(),
          username: username().trim(),
          redirectPath: safeFrom,
        });
        enterPendingState(address);
        return;
      }
      try {
        await signInWithEmailAndPassword(firebaseAuth, address, password());
      } catch (err) {
        // A signup that was never verified has no Firebase identity, so the
        // sign-in fails like a missing account. Probe the pending state and
        // send them to the check-your-email screen instead.
        if (isPendingLoginError(err?.code) && address) {
          let probed = null;
          let probeError = null;
          try {
            probed = await requestVerificationEmail({ resend: true, email: address });
          } catch (probe) {
            probeError = probe;
          }
          // A 429 still proves a pending verification exists for this email.
          if (probed || probeError?.status === 429) {
            enterPendingState(address);
            if (!probed) {
              setResendReadyAt(Date.now() - RESEND_COOLDOWN_MS + (probeError.body?.retryAfterSec || 60) * 1000);
              setNotice(probeError.message);
            }
            return;
          }
        }
        throw err;
      }
      leave(safeFrom);
    } catch (err) {
      setError(err.message || (signup ? 'Registration failed.' : 'Sign in failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    setBusy(true);
    setError('');
    try {
      await requestVerificationEmail({ resend: true, email: pendingEmail() });
      setResendReadyAt(Date.now());
    } catch (err) {
      if (err?.status === 429) {
        const retryAfterSec = Number(err.body?.retryAfterSec) || 60;
        setResendReadyAt(Date.now() - RESEND_COOLDOWN_MS + retryAfterSec * 1000);
      }
      setError(err.message || 'Could not resend the verification email.');
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next) {
    setMode(next);
    setError('');
    setNotice('');
  }

  async function onGoogle() {
    setBusy(true);
    setError('');
    try {
      // Extension side panel is COEP/COOP isolated. A Firebase popup from that
      // iframe is blank or auth/popup-blocked. Finish Google on a real tab.
      if (isAuthFramed()) {
        const opened = window.open(topLevelLoginUrl(window.location.origin, safeFrom), 'pokoin-google-auth');
        if (!opened) {
          throw new Error('Allow popups for pokoin.com, then try Google sign-in again.');
        }
        return;
      }
      await signInWithPopup(firebaseAuth, new GoogleAuthProvider());
      leave(safeFrom);
    } catch (err) {
      if (googleAuthPopupFailed(err)) {
        await signInWithRedirect(firebaseAuth, new GoogleAuthProvider());
        return;
      }
      setError(err.message || 'Google sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  const blockedMs = () => resendCooldownRemainingMs(resendReadyAt(), now());

  return (
    <Switch>
      <Match when={mode() === 'pending'}>
        <div class="page desk">
          <div class="auth-shell">
            <PageHead
              kicker="Account"
              title="Check your email"
              lede="Your Pokoin account is one click away: open the verification link to finish signing up."
            />
            <div class="desk-panel">
              <div class="desk-body">
                <p class="page-lede">
                  Verification link sent to <strong>{pendingEmail() || 'your email'}</strong>.
                  {' '}The link is valid for one hour and only works on a Pokoin domain.
                </p>
                <Alert>{error()}</Alert>
                <button class="btn" type="button" disabled={busy() || blockedMs() > 0} onClick={onResend}>
                  {blockedMs() > 0
                    ? `Resend available in ${Math.ceil(blockedMs() / 1000)}s`
                    : (busy() ? 'Resending…' : 'Resend verification email')}
                </button>
                <button class="btn ghost" type="button" onClick={() => switchMode('signup')}>Use a different email</button>
                <button class="btn ghost" type="button" onClick={() => switchMode('login')}>Back to sign in</button>
              </div>
            </div>
          </div>
        </div>
      </Match>
      <Match when={mode() === 'verifying'}>
        <div class="page desk">
          <div class="auth-shell">
            <PageHead kicker="Account" title="Verifying your email" lede="Finishing your Pokoin account…" />
            <div class="desk-panel">
              <div class="desk-body">
                <Alert>{error()}</Alert>
                <Show when={!error()}><p class="page-lede">One moment — activating your account.</p></Show>
              </div>
            </div>
          </div>
        </div>
      </Match>
      <Match when={true}>
        <div class="page desk">
          <div class="auth-shell">
            <PageHead kicker="Account" title={mode() === 'signup' ? 'Create account' : 'Sign in'} />
            <form class="desk-panel" onSubmit={onEmail}>
              <div class="desk-body">
                <Show when={mode() === 'signup'}>
                  <p class="page-lede">
                    We email you a verification link — the account activates once you open it.
                  </p>
                  <label class="sell-field">
                    Username
                    <input value={username()} onInput={(event) => setUsername(event.target.value)} autocomplete="nickname" />
                  </label>
                </Show>
                <label class="sell-field">
                  Email
                  <input type="email" value={email()} onInput={(event) => setEmail(event.target.value)} autocomplete="email" required />
                </label>
                <label class="sell-field">
                  Password
                  <input
                    type="password"
                    value={password()}
                    onInput={(event) => setPassword(event.target.value)}
                    autocomplete={mode() === 'signup' ? 'new-password' : 'current-password'}
                    required
                  />
                </label>
                <Show when={notice()}><p class="page-lede">{notice()}</p></Show>
                <Alert>{error()}</Alert>
                <button class="btn" type="submit" disabled={busy()}>{busy() ? 'Working…' : (mode() === 'signup' ? 'Create account' : 'Sign in')}</button>
                <button class="btn ghost" type="button" disabled={busy()} onClick={onGoogle}>Continue with Google</button>
                <a class="btn ghost" href="/wallet">Continue with wallet</a>
                <p class="page-lede">
                  {mode() === 'signup' ? 'Already have an account?' : 'Need an account?'}
                  {' '}
                  <button class="linkish" type="button" onClick={() => switchMode(mode() === 'signup' ? 'login' : 'signup')}>
                    {mode() === 'signup' ? 'Sign in' : 'Create one'}
                  </button>
                </p>
              </div>
            </form>
          </div>
        </div>
      </Match>
    </Switch>
  );
}
