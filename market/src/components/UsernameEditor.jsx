import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { changeUsername, ensureUsername } from '../api.js';
import { normalizeUsernameInput, usernameProblem } from '../username.js';

const PENCIL = 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25Zm17.71-10.21a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z';
const CHECK = 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z';
const CLOSE = 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41Z';

function Glyph({ d }) {
  return <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d={d} /></svg>;
}

/** Profile header handle: `@username` with a pencil. The server repairs or
 * assigns the registered name on load; the pencil edits it in place
 * (Enter saves, Escape cancels). */
export default function UsernameEditor({ onSaved }) {
  const { profile, getBearer, setProfileUsername } = useAuth();
  const current = profile?.username || '';
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pencilRef = useRef(null);

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
  const unchanged = clean === current;

  function start() {
    setValue(current);
    setError('');
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setError('');
    setTimeout(() => pencilRef.current?.focus(), 0);
  }

  async function save(event) {
    event?.preventDefault();
    if (unchanged) {
      cancel();
      return;
    }
    if (problem) {
      setError(problem);
      return;
    }
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
      setTimeout(() => pencilRef.current?.focus(), 0);
    } catch (err) {
      setError(err.status === 409 ? `@${clean} is already taken. Try another.` : (err.message || 'Could not change your username.'));
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="username-inline">
        <span className="username-handle">{current ? `@${current}` : 'Setting up your username…'}</span>
        {current ? (
          <button
            ref={pencilRef}
            className="username-pencil"
            type="button"
            onClick={start}
            aria-label="Edit username"
            title="Edit username"
          >
            <Glyph d={PENCIL} />
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <form className="username-inline is-editing" onSubmit={save} noValidate>
      <label className="sr-only" htmlFor="username-input">Username</label>
      <div className={`username-field${error ? ' is-invalid' : ''}`}>
        <span aria-hidden="true">@</span>
        <input
          id="username-input"
          value={value}
          onChange={(event) => { setValue(normalizeUsernameInput(event.target.value)); setError(''); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancel();
            }
          }}
          autoFocus
          onFocus={(event) => event.target.select()}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="username"
          maxLength={32}
          aria-describedby="username-hint"
          aria-invalid={Boolean(error)}
          disabled={saving}
        />
      </div>
      <button className="username-pencil is-save" type="submit" aria-label="Save username" title="Save" disabled={saving || (!unchanged && Boolean(problem))}>
        <Glyph d={CHECK} />
      </button>
      <button className="username-pencil" type="button" onClick={cancel} aria-label="Cancel" title="Cancel" disabled={saving}>
        <Glyph d={CLOSE} />
      </button>
      <p id="username-hint" className={`username-help${error ? ' is-error' : ''}`} role={error ? 'alert' : undefined}>
        {saving ? 'Saving…' : error || '3–32 letters or numbers. Your old name stops working right away.'}
      </p>
    </form>
  );
}
