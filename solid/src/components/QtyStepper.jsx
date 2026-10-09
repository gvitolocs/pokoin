/** Shared − N + quantity control (market/src/components/QtyStepper.jsx). */

function stop(event) {
  event.preventDefault();
  event.stopPropagation();
}

export default function QtyStepper(props) {
  const min = () => props.min ?? 1;
  const max = () => props.max ?? 99;
  const value = () => Math.max(min(), Math.min(max(), Math.trunc(Number(props.qty ?? 1)) || min()));
  return (
    <span class={props.class ?? 'chat-qty'} onClick={stop} onPointerDown={stop}>
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
      <b>{value()}</b>
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
