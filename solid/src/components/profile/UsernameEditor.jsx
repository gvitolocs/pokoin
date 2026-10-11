import { createSignal, onSettled, Show } from 'solid-js';
import { changeUsername, ensureUsername } from '@market/api.js';
import { normalizeUsernameInput, usernameProblem } from '@market/username.js';
import { accountProfile, patchAccountProfile } from '../../stores/account.js';
import { getBearer } from '../../stores/auth.js';

const PENCIL = 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25Zm17.71-10.21a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z';
const CHECK = 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z';
const CLOSE = 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41Z';

export function Glyph(props) {
  return <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d={props.d} /></svg>;
}

export const GLYPHS = { PENCIL, CHECK, CLOSE };

function setProfileUsername(name) {
  const username = String(name || '').trim().toLowerCase();
  if (username) patchAccountProfile({ username });
}

/**
 * Profile header handle (market/src/components/UsernameEditor.jsx): `@username`
 * with a pencil. The server repairs or assigns the registered name on load;
 * the pencil edits it in place (Enter saves, Escape cancels).
 */
export default function UsernameEditor(props) {
  const current = () => accountProfile()?.username || '';
  const [editing, setEditing] = createSignal(false);
  const [value, setValue] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal('');
  let pencil;

  // Make sure the handle on screen is one transfers can resolve.
  onSettled(() => {
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
  });

  const clean = () => normalizeUsernameInput(value());
  const problem = () => usernameProblem(value(), current());
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

  async function save(event) {
    event?.preventDefault();
    if (unchanged()) {
      cancel();
      return;
    }
    if (problem()) {
      setError(problem());
      return;
    }
    const name = clean();
    setSaving(true);
    setError('');
    try {
      const token = await getBearer();
      if (!token) throw new Error('Sign in again to change your username.');
      const result = await changeUsername(name, token);
      const next = result?.username || name;
      setProfileUsername(next);
      setEditing(false);
      props.onSaved?.(`Username changed to @${next}`);
      setTimeout(() => pencil?.focus(), 0);
    } catch (err) {
      setError(err.status === 409 ? `@${name} is already taken. Try another.` : (err.message || 'Could not change your username.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Show
      when={editing()}
      fallback={(
        <div class="username-inline">
          <span class="username-handle">{current() ? `@${current()}` : 'Setting up your username…'}</span>
          <Show when={current()}>
            <button ref={(el) => { pencil = el; }} class="username-pencil" type="button" onClick={start} aria-label="Edit username" title="Edit username">
              <Glyph d={PENCIL} />
            </button>
          </Show>
        </div>
      )}
    >
      <form class="username-inline is-editing" onSubmit={save} novalidate>
        <label class="sr-only" for="username-input">Username</label>
        <div class={['username-field', { 'is-invalid': Boolean(error()) }]}>
          <span aria-hidden="true">@</span>
          <input
            id="username-input"
            ref={(el) => queueMicrotask(() => el.focus())}
            value={value()}
            onInput={(event) => {
              const next = normalizeUsernameInput(event.target.value);
              event.target.value = next;
              setValue(next);
              setError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                cancel();
              }
            }}
            onFocus={(event) => event.target.select()}
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            autocomplete="username"
            maxLength={32}
            aria-describedby="username-hint"
            aria-invalid={String(Boolean(error()))}
            disabled={saving()}
          />
        </div>
        <button class="username-pencil is-save" type="submit" aria-label="Save username" title="Save" disabled={saving() || (!unchanged() && Boolean(problem()))}>
          <Glyph d={CHECK} />
        </button>
        <button class="username-pencil" type="button" onClick={cancel} aria-label="Cancel" title="Cancel" disabled={saving()}>
          <Glyph d={CLOSE} />
        </button>
        <p id="username-hint" class={['username-help', { 'is-error': Boolean(error()) }]} role={error() ? 'alert' : undefined}>
          {saving() ? 'Saving…' : error() || '3–32 letters or numbers. Your old name stops working right away.'}
        </p>
      </form>
    </Show>
  );
}
