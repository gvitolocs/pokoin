import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  GoogleAuthProvider,
  getRedirectResult,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
} from 'firebase/auth';
import { firebaseAuth } from '../auth.jsx';
import { getJson } from '../api.js';
import { googleAuthPopupFailed, isAuthFramed, topLevelLoginUrl } from '../auth-google.js';
import {
  classifyVerifyError,
  isNativeVerifiedReturn,
  isPendingLoginError,
  RESEND_COOLDOWN_MS,
  resendCooldownRemainingMs,
  signupTokenFromSearch,
} from '../email-signup.js';
import { Alert, PageHead } from '../components/Desk.jsx';

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

export default function Auth() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = new URLSearchParams(location.search).get('from') || '/profile';
  const safeFrom = from.startsWith('/') ? from : '/profile';
  const signupToken = signupTokenFromSearch(location.search);
  const verifiedReturn = isNativeVerifiedReturn(location.search);
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // PENDING_EMAIL_VERIFICATION screen state.
  const [pendingEmail, setPendingEmail] = useState('');
  const [resendReadyAt, setResendReadyAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const verifyStartedRef = useRef('');

  useEffect(() => {
    document.title = mode === 'signup'
      ? 'Create account · Pokoin'
      : mode === 'pending'
        ? 'Check your email · Pokoin'
        : mode === 'verifying'
          ? 'Verifying your email · Pokoin'
          : 'Sign in · Pokoin';
  }, [mode]);

  useEffect(() => {
    // Native Firebase action-code returns (?verified=1 from the fallback
    // verification link) land back here as a plain sign-in.
    if (verifiedReturn) {
      setMode('login');
      setNotice('Email verified. Sign in to continue.');
    }
  }, [verifiedReturn]);

  useEffect(() => {
    // The pending/verification screens own this page; auto-redirecting an
    // already-signed-in user away from them would abandon a verification.
    if (signupToken || verifiedReturn) {
      return undefined;
    }
    let cancelled = false;
    getRedirectResult(firebaseAuth)
      .then((result) => {
        if (cancelled || !result?.user) {
          return;
        }
        navigate(safeFrom, { replace: true });
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Google sign-in failed.');
        }
      });
    const stop = firebaseAuth.onAuthStateChanged((user) => {
      if (!cancelled && user) {
        navigate(safeFrom, { replace: true });
      }
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [navigate, safeFrom, signupToken, verifiedReturn]);

  useEffect(() => {
    if (mode !== 'pending') {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [mode]);

  async function enterPendingState(verifiedEmail) {
    setPendingEmail(verifiedEmail);
    setResendReadyAt(Date.now());
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
      navigate(result.redirectPath || safeFrom, { replace: true });
    } catch (err) {
      const classified = classifyVerifyError(err);
      setMode(classified.kind === 'expired' ? 'signup' : 'login');
      if (classified.kind === 'expired') {
        setNotice('This verification link expired. Create the account again to get a fresh link.');
      }
      setError(classified.message);
    }
  }

  useEffect(() => {
    if (!signupToken) {
      return;
    }
    // StrictMode and re-renders re-run effects; one token verifies once.
    if (verifyStartedRef.current === signupToken) {
      return;
    }
    verifyStartedRef.current = signupToken;
    verifySignupToken(signupToken);
  }, [signupToken]);

  async function onEmail(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'signup') {
        // The Pokoin account stays pending until the emailed link is opened;
        // no Firebase identity exists until the backend verifies the token.
        await requestVerificationEmail({
          email: email.trim(),
          password,
          username: username.trim(),
          redirectPath: safeFrom,
        });
        await enterPendingState(email.trim());
        return;
      }
      try {
        await signInWithEmailAndPassword(firebaseAuth, email.trim(), password);
      } catch (err) {
        // A signup that was never verified has no Firebase identity, so the
        // sign-in fails like a missing account. Probe the pending state and
        // send them to the check-your-email screen instead.
        if (isPendingLoginError(err?.code) && email.trim()) {
          let probed = null;
          let probeError = null;
          try {
            probed = await requestVerificationEmail({ resend: true, email: email.trim() });
          } catch (probe) {
            probeError = probe;
          }
          // A 429 still proves a pending verification exists for this email.
          if (probed || probeError?.status === 429) {
            await enterPendingState(email.trim());
            if (!probed) {
              setResendReadyAt(Date.now() - RESEND_COOLDOWN_MS + (probeError.body?.retryAfterSec || 60) * 1000);
              setNotice(probeError.message);
            }
            return;
          }
        }
        throw err;
      }
      navigate(safeFrom, { replace: true });
    } catch (err) {
      setError(err.message || (mode === 'signup' ? 'Registration failed.' : 'Sign in failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    setBusy(true);
    setError('');
    try {
      await requestVerificationEmail({ resend: true, email: pendingEmail });
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
      navigate(safeFrom, { replace: true });
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

  if (mode === 'pending') {
    const blockedMs = resendCooldownRemainingMs(resendReadyAt, now);
    const blockedSec = Math.ceil(blockedMs / 1000);
    return (
      <div className="page desk">
        <div className="auth-shell">
          <PageHead
            kicker="Account"
            title="Check your email"
            lede="Your Pokoin account is one click away: open the verification link to finish signing up."
          />
          <div className="desk-panel">
            <div className="desk-body">
              <p className="page-lede">
                Verification link sent to <strong>{pendingEmail || 'your email'}</strong>.
                {' '}The link is valid for one hour and only works on a Pokoin domain.
              </p>
              <Alert>{error}</Alert>
              <button className="btn" type="button" disabled={busy || blockedMs > 0} onClick={onResend}>
                {blockedMs > 0
                  ? `Resend available in ${blockedSec}s`
                  : (busy ? 'Resending…' : 'Resend verification email')}
              </button>
              <button className="btn ghost" type="button" onClick={() => switchMode('signup')}>Use a different email</button>
              <button className="btn ghost" type="button" onClick={() => switchMode('login')}>Back to sign in</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'verifying') {
    return (
      <div className="page desk">
        <div className="auth-shell">
          <PageHead
            kicker="Account"
            title="Verifying your email"
            lede="Finishing your Pokoin account…"
          />
          <div className="desk-panel">
            <div className="desk-body">
              <Alert>{error}</Alert>
              {!error ? <p className="page-lede">One moment — activating your account.</p> : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page desk">
      <div className="auth-shell">
        <PageHead
          kicker="Account"
          title={mode === 'signup' ? 'Create account' : 'Sign in'}
          lede="Same Firebase project as Android/iOS. Returns to the page you left."
        />
        <form className="desk-panel" onSubmit={onEmail}>
          <div className="desk-body">
            {mode === 'signup' ? (
              <p className="page-lede">
                We email you a verification link — the account activates once you open it.
              </p>
            ) : null}
            {mode === 'signup' ? (
              <label className="sell-field">
                Username
                <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="nickname" />
              </label>
            ) : null}
            <label className="sell-field">
              Email
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
            </label>
            <label className="sell-field">
              Password
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required />
            </label>
            {notice ? <p className="page-lede">{notice}</p> : null}
            <Alert>{error}</Alert>
            <button className="btn" type="submit" disabled={busy}>{busy ? 'Working…' : (mode === 'signup' ? 'Create account' : 'Sign in')}</button>
            <button className="btn ghost" type="button" disabled={busy} onClick={onGoogle}>Continue with Google</button>
            <Link className="btn ghost" to="/wallet">Continue with wallet</Link>
            <p className="page-lede">
              {mode === 'signup' ? 'Already have an account?' : 'Need an account?'}
              {' '}
              <button className="linkish" type="button" onClick={() => switchMode(mode === 'signup' ? 'login' : 'signup')}>
                {mode === 'signup' ? 'Sign in' : 'Create one'}
              </button>
            </p>
          </div>
        </form>
      </div>
    </div>
  );
}
