import { createMemo, createSignal, onSettled, Show, untrack } from 'solid-js';
import { lineKeyOf, lineLocation, lineLocationFromPt, lineQuantity } from '@market/zero-pick.js';
import ScanImage from '../ScanImage.jsx';
import { FacetBadges, IssueBadge, lineImage, linePrice, lineWhere, PtPlace, TakeBits } from './zero-bits.jsx';

const TYPING = 'input, textarea, select, [contenteditable="true"]';

/**
 * One card at a time, in picking order. Enter / Space marks the line fully
 * picked and moves to the next line still to pick; arrows walk; Backspace
 * unpicks; Escape closes. `inline` is the "Single image" view: the same
 * card on the page instead of a modal (no Close, no Escape).
 */
export default function PickingMode(props) {
  let box;
  const firstOpen = () => {
    const index = props.lines.findIndex((line) => !props.isDone(line));
    return index < 0 ? 0 : index;
  };
  const [index, setIndex] = createSignal(untrack(firstOpen));
  const line = createMemo(() => props.lines[Math.min(index(), props.lines.length - 1)]);
  const pick = () => props.pickOf(line());
  const doneCount = () => props.lines.filter((entry) => props.isDone(entry)).length;
  const slot = () => line()?.slot || null;

  function nextOpen(from) {
    const lines = props.lines;
    for (let step = 1; step <= lines.length; step += 1) {
      const at = (from + step) % lines.length;
      if (!props.isDone(lines[at])) return at;
    }
    return from;
  }

  function pickAndNext() {
    const current = untrack(index);
    const entry = props.lines[current];
    if (!entry || props.isBusy?.(entry)) return;
    if (!props.isDone(entry)) props.onSetPicked(entry, lineQuantity(entry));
    setIndex(nextOpen(current));
  }

  const go = (delta) => setIndex((at) => Math.max(0, Math.min(props.lines.length - 1, at + delta)));
  const unpick = () => {
    const entry = props.lines[untrack(index)];
    if (entry && !props.isBusy?.(entry) && props.pickOf(entry).picked) props.onSetPicked(entry, 0);
  };

  onSettled(() => {
    const opener = document.activeElement;
    if (!props.inline) box?.focus();
    const onKey = (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target?.closest?.(TYPING)) return;
      // A focused button handles its own Enter / Space.
      if ((event.key === 'Enter' || event.key === ' ') && target?.closest?.('button, a')) return;
      if (event.key === 'Enter' || event.key === ' ') pickAndNext();
      else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') go(1);
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') go(-1);
      else if (event.key === 'Backspace') unpick();
      else if (event.key === 'Escape' && !props.inline) props.onClose();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (!props.inline && opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  });

  const card = () => (
      <div
        ref={box}
        class={['zero-picking', { 'is-inline': Boolean(props.inline) }]}
        role={props.inline ? 'region' : 'dialog'}
        aria-modal={props.inline ? undefined : 'true'}
        aria-labelledby="zero-picking-title"
        tabindex="-1"
      >
        <div class="zero-picking-head">
          <h2 id="zero-picking-title">{props.inline ? 'Single image' : 'Picking'}</h2>
          <span class="zero-picking-progress" aria-live="polite">
            {index() + 1} / {props.lines.length} · {doneCount()} picked
          </span>
          <Show when={!props.inline}>
            <button class="btn ghost" type="button" onClick={props.onClose}>Close</button>
          </Show>
        </div>
        <Show when={line()}>
          <div class={['zero-picking-body', { 'is-done': props.isDone(line()) }]} data-line-key={lineKeyOf(line())}>
            <div class="zero-picking-art">
              <ScanImage src={lineImage(line())} label={line().name} letterClass="zero-card-fallback" width="252" height="352" />
            </div>
            <div class="zero-picking-info">
              <div class="zero-picking-loc">
                <Show when={lineLocation(line())} fallback={<span class="is-empty">No location</span>}>
                  <Show
                    when={!lineLocationFromPt(line()) && slot()?.box}
                    fallback={<span title="Location from Power Tools"><small>Power Tools location</small>{lineLocation(line())}</span>}
                  >
                    <span><small>Box</small>{slot().box}</span>
                    <Show when={slot()?.stack != null}><span><small>Stack</small>{slot().stack}</span></Show>
                    <Show when={slot()?.position != null}><span><small>Position</small>{slot().position}</span></Show>
                  </Show>
                </Show>
              </div>
              <p class="zero-picking-take">
                Take {lineQuantity(line())}
                <span class="zero-picking-count">picked {pick().picked}/{lineQuantity(line())}</span>
              </p>
              <h3 class="zero-picking-name">{line().name}</h3>
              <Show when={line().nameEn}><p class="thread-meta">{line().nameEn}</p></Show>
              <Show when={lineWhere(line())}><p class="thread-meta">{lineWhere(line())}</p></Show>
              <div class="zero-line-tags">
                <FacetBadges item={line()} />
                <TakeBits item={line()} />
                <PtPlace item={line()} />
                <IssueBadge issue={pick().issue} />
              </div>
              <Show when={linePrice(line())}><p class="zero-card-price">{linePrice(line())}</p></Show>
              <Show when={line().powerTools?.bin}><p class="thread-meta">PT bin {line().powerTools.bin}</p></Show>
              <Show when={props.noteOf?.(line())}><p class="zero-inventory-note" role="status">{props.noteOf(line())}</p></Show>
              <Show when={props.errorOf?.(line())}><p class="zero-save-error" role="alert">{props.errorOf(line())}</p></Show>
            </div>
          </div>
        </Show>
        <div class="zero-picking-actions">
          <button class="btn ghost" type="button" onClick={() => go(-1)} disabled={index() <= 0}>Previous</button>
          <button class="btn ghost" type="button" onClick={unpick} disabled={!line() || props.isBusy?.(line()) || !pick().picked}>Unpick</button>
          <button class="btn" type="button" onClick={pickAndNext} disabled={!line() || props.isBusy?.(line())}>
            {line() && props.isBusy?.(line()) ? 'Saving…' : 'Picked, next'}
          </button>
          <button class="btn ghost" type="button" onClick={() => go(1)} disabled={index() >= props.lines.length - 1}>Next</button>
        </div>
        <p class="zero-picking-keys thread-meta">
          Enter or Space: picked, next · ← →: walk · Backspace: unpick{props.inline ? '' : ' · Esc: close'}
        </p>
      </div>
  );

  return (
    <Show when={!props.inline} fallback={card()}>
      <div class="modal-backdrop zero-picking-backdrop" role="presentation">{card()}</div>
    </Show>
  );
}
