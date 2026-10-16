import { createSignal, Show } from 'solid-js';
import { changeDisplayName } from '@market/api.js';
import { accountHeading } from '@market/auth-session.js';
import { displayNameProblem, normalizeDisplayName } from '@market/display-name.js';
import { accountProfile, patchAccountProfile } from '../../stores/account.js';
import { authUser, getBearer } from '../../stores/auth.js';
import { Glyph, GLYPHS } from './UsernameEditor.jsx';

function editableName(user, profile) {
  const heading = accountHeading(user, profile);
  if (!heading || heading === 'Collector') return '';
  if (heading.includes('@')) return heading.split('@')[0];
  return heading;
}

/** Profile title: the display name with the same pencil as the @handle. */
export default function DisplayNameEditor(props) {
  const current = () => editableName(authUser() || null, accountProfile());
  const [editing, setEditing] = createSignal(false);
  const [value, setValue] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal('');
  let pencil;

  const clean = () => normalizeDisplayName(value());
  const problem = () => displayNameProblem(value());
  const unchanged = () => clean() === current();

  function start() {
    setValue(current());
    setError('');
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setError('');
    setTimeout(() => pencil?.focus(), 0);
  }

  async function save() {
    if (unchanged()) {
      cancel();
      return;
    }
    if (problem()) {
      setError(problem());
      return;
    }
    setSaving(true);
    setError('');
    try {
      const token = await getBearer();
      if (!token) throw new Error('Sign in again to change your name.');
      const result = await changeDisplayName(clean(), token);
      const next = result?.displayName || clean();
      const { firebaseAuth, updateProfile } = await import('@market/firebase-signin.js');
      if (firebaseAuth.currentUser) await updateProfile(firebaseAuth.currentUser, { displayName: next });
      const displayName = String(next || '').trim();
      if (displayName) patchAccountProfile({ displayName });
      setEditing(false);
      props.onSaved?.('Display name updated');
      setTimeout(() => pencil?.focus(), 0);
    } catch (err) {
      setError(err.message || 'Could not change your name.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Show
      when={editing()}
      fallback={(
        <span class="display-name-inline">
          <span>{current() || 'Collector'}</span>
          <button ref={(el) => { pencil = el; }} class="username-pencil" type="button" onClick={start} aria-label="Edit display name" title="Edit display name">
            <Glyph d={GLYPHS.PENCIL} />
          </button>
        </span>
      )}
    >
      <span class="display-name-inline is-editing">
        <label class="sr-only" for="display-name-input">Display name</label>
        <input
          id="display-name-input"
          ref={(el) => queueMicrotask(() => el.focus())}
          value={value()}
          onInput={(event) => { setValue(event.target.value); setError(''); }}
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
          onFocus={(event) => event.target.select()}
          autocapitalize="words"
          autocorrect="off"
          spellcheck="false"
          autocomplete="nickname"
          maxLength={40}
          aria-invalid={String(Boolean(error()))}
          disabled={saving()}
        />
        <button class="username-pencil is-save" type="button" onClick={save} aria-label="Save display name" title="Save" disabled={saving() || (!unchanged() && Boolean(problem()))}>
          <Glyph d={GLYPHS.CHECK} />
        </button>
        <button class="username-pencil" type="button" onClick={cancel} aria-label="Cancel" title="Cancel" disabled={saving()}>
          <Glyph d={GLYPHS.CLOSE} />
        </button>
        <span class={['display-name-help', { 'is-error': Boolean(error()) }]} role={error() ? 'alert' : undefined}>
          {saving() ? 'Saving…' : error() || 'Shown on your profile. 2–40 characters.'}
        </span>
      </span>
    </Show>
  );
}
