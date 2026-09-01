import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
} from 'firebase/auth';
import { firebaseAuth } from '../auth.jsx';

export default function Auth() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = new URLSearchParams(location.search).get('from') || '/profile';
  const safeFrom = from.startsWith('/') ? from : '/profile';
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = mode === 'signup' ? 'Create account · Pokoin' : 'Sign in · Pokoin';
  }, [mode]);

  async function onEmail(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'signup') {
        const cred = await createUserWithEmailAndPassword(firebaseAuth, email.trim(), password);
        if (username.trim()) {
          await updateProfile(cred.user, { displayName: username.trim() });
        }
      } else {
        await signInWithEmailAndPassword(firebaseAuth, email.trim(), password);
      }
      navigate(safeFrom, { replace: true });
    } catch (err) {
      setError(err.message || 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    setBusy(true);
    setError('');
    try {
      await signInWithPopup(firebaseAuth, new GoogleAuthProvider());
      navigate(safeFrom, { replace: true });
    } catch (err) {
      setError(err.message || 'Google sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page app-page">
      <div className="comp-head">
        <div>
          <p className="eyebrow">Account</p>
          <h1>{mode === 'signup' ? 'Create account' : 'Sign in'}</h1>
          <p className="muted">Same Firebase project as Android/iOS CardVault. Returns to {safeFrom}.</p>
        </div>
      </div>
      <form className="panel auth-card" onSubmit={onEmail}>
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
        {error ? <p className="status error">{error}</p> : null}
        <button className="btn" type="submit" disabled={busy}>{busy ? 'Working…' : (mode === 'signup' ? 'Create account' : 'Sign in')}</button>
        <button className="btn ghost" type="button" disabled={busy} onClick={onGoogle}>Continue with Google</button>
        <p className="muted">
          {mode === 'signup' ? 'Already have an account?' : 'Need an account?'}
          {' '}
          <button className="linkish" type="button" onClick={() => setMode((current) => (current === 'signup' ? 'login' : 'signup'))}>
            {mode === 'signup' ? 'Sign in' : 'Create one'}
          </button>
        </p>
        <p className="muted"><Link to="/wallet">Connect a wallet</Link> without an email.</p>
      </form>
    </div>
  );
}
