/** Shared − N + quantity control (chat tags, cart tray, Desktop tray). */

function stop(event) {
  event.preventDefault();
  event.stopPropagation();
}

export default function QtyStepper({
  qty = 1,
  min = 1,
  max = 99,
  onChange,
  className = 'chat-qty',
}) {
  const value = Math.max(min, Math.min(max, Math.trunc(Number(qty)) || min));
  return (
    <span className={className} onClick={stop} onPointerDown={stop}>
      <button
        type="button"
        aria-label="Decrease quantity"
        disabled={value <= min}
        onClick={(event) => {
          stop(event);
          onChange?.(value - 1);
        }}
      >
        −
      </button>
      <b>{value}</b>
      <button
        type="button"
        aria-label="Increase quantity"
        disabled={value >= max}
        onClick={(event) => {
          stop(event);
          onChange?.(value + 1);
        }}
      >
        +
      </button>
    </span>
  );
}
