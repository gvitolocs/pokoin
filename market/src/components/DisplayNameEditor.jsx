import { useRef, useState } from 'react';
import { updateProfile } from 'firebase/auth';
import { firebaseAuth, useAuth } from '../auth.jsx';
import { accountHeading } from '../auth-session.js';
import { changeDisplayName } from '../api.js';
import { displayNameProblem, normalizeDisplayName } from '../display-name.js';

const PENCIL = 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25Zm17.71-10.21a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z';
const CHECK = 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z';
const CLOSE = 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41Z';

function Glyph({ d }) {
  return <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d={d} /></svg>;
}

function editableName(user, profile) {
  const heading = accountHeading(user, profile);
  if (!heading || heading === 'Collector') return '';
  if (heading.includes('@')) return heading.split('@')[0];
  return heading;
}

/** Profile title: the display name with the same pencil as the @handle. */
export default function DisplayNameEditor({ onSaved }) {
  const { user, profile, getBearer, setProfileDisplayName } = useAuth();
  const current = editableName(user, profile);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pencilRef = useRef(null);

  const clean = normalizeDisplayName(value);
  const problem = displayNameProblem(value);
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

  async function save() {
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
      if (!token) throw new Error('Sign in again to change your name.');
      const result = await changeDisplayName(clean, token);
      const next = result?.displayName || clean;
      if (firebaseAuth.currentUser) {
        await updateProfile(firebaseAuth.currentUser, { displayName: next });
      }
      setProfileDisplayName?.(next);
      setEditing(false);
      onSaved?.('Display name updated');
      setTimeout(() => pencilRef.current?.focus(), 0);
    } catch (err) {
      setError(err.message || 'Could not change your name.');
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <span className="display-name-inline">
        <span>{current || 'Collector'}</span>
        <button
          ref={pencilRef}
          className="username-pencil"
          type="button"
          onClick={start}
          aria-label="Edit display name"
          title="Edit display name"
        >
          <Glyph d={PENCIL} />
        </button>
      </span>
    );
  }

  return (
    <span className="display-name-inline is-editing">
      <label className="sr-only" htmlFor="display-name-input">Display name</label>
      <input
        id="display-name-input"
        value={value}
        onChange={(event) => { setValue(event.target.value); setError(''); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            save();
          }
        }}
        autoFocus
        onFocus={(event) => event.target.select()}
        autoCapitalize="words"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="nickname"
        maxLength={40}
        aria-invalid={Boolean(error)}
        disabled={saving}
      />
      <button className="username-pencil is-save" type="button" onClick={save} aria-label="Save display name" title="Save" disabled={saving || (!unchanged && Boolean(problem))}>
        <Glyph d={CHECK} />
      </button>
      <button className="username-pencil" type="button" onClick={cancel} aria-label="Cancel" title="Cancel" disabled={saving}>
        <Glyph d={CLOSE} />
      </button>
      <span className={`display-name-help${error ? ' is-error' : ''}`} role={error ? 'alert' : undefined}>
        {saving ? 'Saving…' : error || 'Shown on your profile. 2–40 characters.'}
      </span>
    </span>
  );
}
