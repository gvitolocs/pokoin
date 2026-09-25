import { useEffect, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { changeUsername, ensureUsername } from '../api.js';
import { normalizeUsernameInput, usernameProblem } from '../username.js';

/** Profile "Pokoin username" row: shows the registered handle (the server
 * repairs or assigns it on load) and lets the user claim a new one. */
export default function UsernameEditor({ onSaved }) {
  const { profile, getBearer, setProfileUsername } = useAuth();
  const current = profile?.username || '';
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Make sure the handle on screen is one transfers can resolve.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const token = await getBearer();
        if (!token) return;
        const result = await ensureUsername(token);
        if (live && result?.username) setProfileUsername(result.username);
      } catch (_) {
        /* keep the profile value; the Receive sheet retries */
      }
    })();
    return () => { live = false; };
  }, [getBearer, setProfileUsername]);

  const clean = normalizeUsernameInput(value);
  const problem = usernameProblem(value, current);

  function start() {
    setValue(current);
    setTouched(false);
    setError('');
    setEditing(true);
  }

  async function save(event) {
    event.preventDefault();
    setTouched(true);
    if (problem) return;
    setSaving(true);
    setError('');
    try {
      const token = await getBearer();
      if (!token) throw new Error('Sign in again to change your username.');
      const result = await changeUsername(clean, token);
      const next = result?.username || clean;
      setProfileUsername(next);
      setEditing(false);
      onSaved?.(`Username changed to @${next}`);
    } catch (err) {
      setError(err.status === 409 ? `@${clean} is already taken. Try another.` : (err.message || 'Could not change your username.'));
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="username-row">
        <div>
          <p className="username-handle">{current ? `@${current}` : 'Setting up your username…'}</p>
          <p className="username-help">People send you PKN and messages with this name.</p>
        </div>
        <button className="btn ghost" type="button" onClick={start} disabled={!current}>Change</button>
      </div>
    );
  }

  return (
    <form className="username-form" onSubmit={save} noValidate>
      <label className="username-label" htmlFor="username-input">New username</label>
      <div className={`username-field${touched && problem ? ' is-invalid' : ''}`}>
        <span aria-hidden="true">@</span>
        <input
          id="username-input"
          value={value}
          onChange={(event) => { setValue(normalizeUsernameInput(event.target.value)); setError(''); }}
          onBlur={() => setTouched(true)}
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="username"
          inputMode="text"
          maxLength={32}
          aria-describedby="username-hint"
          aria-invalid={Boolean(touched && problem)}
          disabled={saving}
        />
      </div>
      <p id="username-hint" className={`username-help${(touched && problem) || error ? ' is-error' : ''}`} role={error ? 'alert' : undefined}>
        {error || (touched && problem) || '3–32 letters or numbers. Your old name stops working right away.'}
      </p>
      <div className="username-actions">
        <button className="btn" type="submit" disabled={saving || Boolean(problem)}>{saving ? 'Saving…' : 'Save username'}</button>
        <button className="btn ghost" type="button" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
      </div>
    </form>
  );
}
