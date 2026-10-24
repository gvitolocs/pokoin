import { createSignal, For, onSettled, Show, untrack } from 'solid-js';
import { ISSUE_NOTE_MAX, ISSUE_TYPES } from '@market/zero-pick.js';
import { LocationText } from './zero-bits.jsx';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal shell for the Zero picking dialogs: focuses the first control on open,
 * Escape closes, and focus returns to whatever opened it.
 */
export function ZeroDialog(props) {
  let box;
  onSettled(() => {
    const opener = document.activeElement;
    box?.querySelector(FOCUSABLE)?.focus();
    return () => {
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  });
  return (
    <div
      class="modal-backdrop zero-dialog-backdrop"
      role="presentation"
      onClick={(event) => event.target === event.currentTarget && props.onClose()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }}
    >
      <div ref={box} class="modal-card zero-dialog" role="dialog" aria-modal="true" aria-labelledby={props.titleId}>
        <h2 id={props.titleId} class="zero-dialog-title">{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

/** Picked copies for a line with quantity > 1 (Power Tools' picked-quantity dialog). */
export function PickQuantityDialog(props) {
  const line = () => props.line;
  const quantity = () => Math.max(1, Number(line().quantity) || 1);
  const set = (value) => props.onChange(Math.max(0, Math.min(quantity(), value)));
  return (
    <ZeroDialog titleId="zero-qty-title" title={`Picked copies · ${line().name || 'Card'}`} onClose={props.onClose}>
      <p class="thread-meta"><LocationText item={line()} /> · take {quantity()}</p>
      <div class="zero-qty-stepper">
        <button class="btn ghost" type="button" aria-label="One less" onClick={() => set(props.picked - 1)} disabled={props.picked <= 0}>−</button>
        <output class="zero-qty-value" aria-live="polite">{props.picked}/{quantity()}</output>
        <button class="btn ghost" type="button" aria-label="One more" onClick={() => set(props.picked + 1)} disabled={props.picked >= quantity()}>+</button>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" type="button" onClick={() => set(quantity())}>All</button>
        <button class="btn ghost" type="button" onClick={() => set(0)}>None</button>
        <button class="btn" type="button" onClick={props.onClose}>Done</button>
      </div>
    </ZeroDialog>
  );
}

/** "What issue would you like to report?" for one line. */
export function IssueDialog(props) {
  const [type, setType] = createSignal(untrack(() => props.issue?.type) || 'missing');
  const [note, setNote] = createSignal(untrack(() => props.issue?.note) || '');
  return (
    <ZeroDialog titleId="zero-issue-title" title="What issue would you like to report?" onClose={props.onClose}>
      <p class="thread-meta">{props.line.name} · <LocationText item={props.line} /></p>
      <form
        class="zero-issue-form"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSave({ type: type(), note: note().trim().slice(0, ISSUE_NOTE_MAX) });
        }}
      >
        <fieldset class="zero-issue-types">
          <legend class="sr-only">Issue</legend>
          <For each={ISSUE_TYPES}>
            {(entry) => (
              <label class="zero-issue-type">
                <input
                  type="radio"
                  name="zero-issue-type"
                  value={entry.id}
                  checked={type() === entry.id}
                  onChange={() => setType(entry.id)}
                />
                {entry.label}
              </label>
            )}
          </For>
        </fieldset>
        <label class="zero-issue-note">
          <span>Note</span>
          <textarea
            rows="3"
            maxlength={ISSUE_NOTE_MAX}
            value={note()}
            onInput={(event) => setNote(event.target.value)}
            placeholder="Optional"
          />
          <small>{note().length}/{ISSUE_NOTE_MAX}</small>
        </label>
        <div class="modal-actions">
          <button class="btn" type="submit">Save issue</button>
          <Show when={props.issue}>
            <button class="btn ghost" type="button" onClick={props.onClear}>Clear issue</button>
          </Show>
          <button class="btn ghost" type="button" onClick={props.onClose}>Cancel</button>
        </div>
      </form>
    </ZeroDialog>
  );
}

/** "Picked from another box…": the identical copies this line could have come from. */
export function SwapDialog(props) {
  return (
    <ZeroDialog titleId="zero-swap-title" title="Picked from another box" onClose={props.onClose}>
      <p class="thread-meta">
        {props.line.name} · sold copy in <LocationText item={props.line} />. Pick the box the copy actually came from:
        that copy leaves your inventory and the sold one goes back on sale.
      </p>
      <div class="zero-swap-list">
        <For each={props.copies}>
          {(copy) => (
            <button class="btn ghost" type="button" disabled={props.busy} onClick={() => props.onChoose(copy.listingId)}>
              {copy.location || 'No location'}
              <Show when={copy.quantityAvailable != null}> · {copy.quantityAvailable} available</Show>
            </button>
          )}
        </For>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" type="button" onClick={props.onClose}>Cancel</button>
      </div>
    </ZeroDialog>
  );
}

/** Confirmation before the one Power Tools write: the dry run's card count. */
export function PtSortDialog(props) {
  return (
    <ZeroDialog titleId="zero-ptsort-title" title="Apply sort on CardTrader" onClose={props.onCancel}>
      <p>Send this order ({props.count} cards) to CardTrader through Power Tools?</p>
      <Show when={props.label}><p class="thread-meta">{props.label}</p></Show>
      <div class="modal-actions">
        <button class="btn ghost" type="button" onClick={props.onCancel} disabled={props.busy}>Cancel</button>
        <button class="btn" type="button" onClick={props.onSend} disabled={props.busy}>{props.busy ? 'Sending…' : 'Send'}</button>
      </div>
    </ZeroDialog>
  );
}
