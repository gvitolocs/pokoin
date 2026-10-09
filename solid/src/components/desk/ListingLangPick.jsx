import { createEffect, createSignal, For, Show } from 'solid-js';
import { flagSrc } from '@market/locale.js';

function Flag(props) {
  return <img src={flagSrc(props.code)} alt="" width="16" height="16" />;
}

/** Close an open picker on an outside pointer or Escape (same as the React pickers). */
export function dismissWhileOpen(open, setOpen, root) {
  createEffect(open, (isOpen) => {
    if (!isOpen) return undefined;
    const onDoc = (event) => {
      if (!root()?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  });
}

/** Listing language picker (market/src/components/ListingLangPick.jsx). */
export default function ListingLangPick(props) {
  const [open, setOpen] = createSignal(false);
  let root;
  dismissWhileOpen(open, setOpen, () => root);

  function pick(code) {
    setOpen(false);
    const jump = (props.redirects || []).find((row) => row.code === code);
    if (jump) props.onRedirect(jump);
    else props.onChange(code);
  }

  return (
    <div class={['lang-pick', { 'is-open': open() }]} ref={(el) => { root = el; }}>
      <button
        type="button"
        class="lang-pick-btn"
        aria-haspopup="listbox"
        aria-expanded={open() ? 'true' : 'false'}
        aria-label={`Language ${props.value}`}
        onClick={() => setOpen((next) => !next)}
      >
        <Flag code={props.value} />
        <span>{props.value}</span>
      </button>
      <Show when={open()}>
        <ul class="lang-pick-menu" role="listbox">
          <For each={props.listed || []}>
            {(code) => (
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={code === props.value ? 'true' : 'false'}
                  onClick={() => pick(code)}
                >
                  <Flag code={code} />
                  <span>{code}</span>
                  <Show when={code === props.value}><em aria-hidden="true">✓</em></Show>
                </button>
              </li>
            )}
          </For>
          <For each={props.redirects || []}>
            {(row) => (
              <li>
                <button type="button" role="option" aria-selected="false" onClick={() => pick(row.code)}>
                  <Flag code={row.code} />
                  <span>{row.code}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
