/** Shared − N + quantity control. `editable` also lets the seller type it. */

import { createSignal } from 'solid-js';

function stop(event) {
  event.preventDefault();
  event.stopPropagation();
}

export default function QtyStepper(props) {
  const min = () => props.min ?? 1;
  const max = () => props.max ?? 99;
  const value = () => Math.max(min(), Math.min(max(), Math.trunc(Number(props.qty ?? 1)) || min()));
  // What is typed stays on screen while the field has focus: clamping "4" to the
  // value would otherwise delete it before the seller types the second digit.
  const [text, setText] = createSignal(null);
  const shown = () => (text() == null ? String(value()) : text());
  return (
    <span
      class={[props.class ?? 'chat-qty', { 'is-editable': Boolean(props.editable) }]}
      {...(props.editable ? {} : { onClick: stop, onPointerDown: stop })}
    >
      <button
        type="button"
        aria-label="Decrease quantity"
        disabled={value() <= min()}
        onClick={(event) => {
          stop(event);
          props.onChange?.(value() - 1);
        }}
      >
        −
      </button>
      {props.editable ? (
        <input
          class="chat-qty-input"
          type="text"
          inputMode="numeric"
          size={String(max()).length}
          aria-label={props.label || 'Quantity'}
          value={shown()}
          onFocus={() => setText(String(value()))}
          onBlur={() => setText(null)}
          onInput={(event) => {
            setText(event.currentTarget.value);
            props.onChange?.(event.currentTarget.value);
          }}
        />
      ) : (
        <b>{value()}</b>
      )}
      <button
        type="button"
        aria-label="Increase quantity"
        disabled={value() >= max()}
        onClick={(event) => {
          stop(event);
          props.onChange?.(value() + 1);
        }}
      >
        +
      </button>
    </span>
  );
}
