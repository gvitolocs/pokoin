import { onSettled, Show } from 'solid-js';

/** `document.title` for a page that sets nothing else in the head (React: a mount effect). */
export function usePageTitle(title) {
  onSettled(() => {
    document.title = title;
  });
}

/** Header strip every test.pokoin.com board starts with. */
export function BoardBar(props) {
  return (
    <header class="sanitize-bar">
      <a class="brand" href="https://pokoin.com/" aria-label="Pokoin">
        <img src="/home/logo.png" alt="" width="40" height="40" />
        <span>Pokoin</span>
      </a>
      <p class="sanitize-host">{props.host}</p>
      {props.children}
    </header>
  );
}

/** "Hairlines" / "Zones" checkbox in the board bar. */
export function BoardToggle(props) {
  return (
    <label class="sanitize-toggle">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      {props.children}
    </label>
  );
}

function ZoomModal(props) {
  let el;
  onSettled(() => {
    if (el && !el.open) el.showModal();
  });
  return (
    <dialog
      ref={el}
      class="zoom"
      onClose={() => props.onClose()}
      onClick={(event) => {
        if (event.target === el) props.onClose();
      }}
    >
      <img src={props.shot.src} alt={props.shot.label} onClick={() => props.onClose()} />
    </dialog>
  );
}

/** Full-size image dialog the review boards open on a click (`{ src, label }` or null). */
export function ZoomDialog(props) {
  return (
    <Show when={props.shot}>
      {(shot) => <ZoomModal shot={shot()} onClose={props.onClose} />}
    </Show>
  );
}
