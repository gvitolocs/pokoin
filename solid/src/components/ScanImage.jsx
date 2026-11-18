import { createSignal, Show } from 'solid-js';

/** First letter of a card name, for tiles whose scan is missing or failed. */
export function scanLetter(label) {
  const text = String(label || '?').trim();
  return (text.slice(0, 1) || '?').toUpperCase();
}

function appendLetter(parent, label, letterClass) {
  const span = document.createElement('span');
  span.className = letterClass || 'scan-letter';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = scanLetter(label);
  parent.appendChild(span);
}

/**
 * Art node for the drag ghost. A letter replaces the image when `src` is
 * empty or the request fails.
 */
export function fillScanNode(parent, { src, label, letterClass } = {}) {
  parent.replaceChildren();
  if (!src) {
    appendLetter(parent, label, letterClass);
    return;
  }
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  img.addEventListener('error', () => {
    img.remove();
    appendLetter(parent, label, letterClass);
  }, { once: true });
  img.src = src;
  parent.appendChild(img);
}

/** Portrait scan. Empty src and a failed load both show the letter. */
export default function ScanImage(props) {
  const [failed, setFailed] = createSignal('');
  const broken = () => !props.src || failed() === props.src;
  return (
    <Show
      when={!broken()}
      fallback={<span class={props.letterClass || 'scan-letter'} aria-hidden="true">{scanLetter(props.label)}</span>}
    >
      <img
        class={props.class}
        src={props.src}
        alt={props.alt ?? ''}
        width={props.width}
        height={props.height}
        loading={props.loading ?? 'lazy'}
        decoding={props.decoding ?? 'async'}
        draggable={props.draggable === true ? 'true' : 'false'}
        onError={() => setFailed(String(props.src || ''))}
      />
    </Show>
  );
}
