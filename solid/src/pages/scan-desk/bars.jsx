import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from 'solid-js';
import { GAMES, gameBasename, gameIdFromHost, setScanGameOverride } from '@market/game.js';
import { encodeQr, qrLogoLayout, qrPath } from '@market/qr.js';
import { phoneConnectUrl } from '@market/scan-api.js';
import { CONDITIONS, FINISHES, LANGUAGES, STACK_SIZES } from '@market/scan-model.js';
import { HELP_SECTIONS } from '@market/scan-shortcuts.js';
import { FIELD_LABEL, perfRows, perfSink } from './version-sets.js';
import {
  draftValue,
  gearState,
  isLocationOff,
  LOCATION_OFF_PATCH,
  locationFieldState,
  pendingDraft,
  sizeCommit,
  STACK_OFF_PATCH,
} from './defaults-state.js';
import { pricingChoicePatch, pricingChoiceValue, pricingHint, pricingOptions } from './pricing.js';

/** Pairing QR: ECC H with a centered Pokoin logo on a white pad (D00006I). */
export function QrBlock(props) {
  const url = () => (props.secret ? phoneConnectUrl(props.secret, props.pin) : '');
  const layout = createMemo(() => {
    const value = url();
    if (!value) return null;
    try {
      // ECC H (~30% recovery) so a small centered Pokoin logo stays scannable.
      const qr = encodeQr(value, { ecc: 'H' });
      return { d: qrPath(qr), ...qrLogoLayout(qr) };
    } catch (_) {
      return null;
    }
  });
  return (
    <Show when={layout()}>
      {(path) => (
        <figure class="scan-qr" data-connect-url={url()}>
          <svg viewBox={`0 0 ${path().view} ${path().view}`} role="img" aria-label="QR code to connect your phone" shape-rendering="crispEdges">
            <rect width={path().view} height={path().view} fill="#fff" />
            <path d={path().d} fill="#000" />
            {/* White pad + Pokoin mark: ~20% logo / ~28% pad of the module field. */}
            <circle cx={path().cx} cy={path().cy} r={path().pad / 2} fill="#fff" />
            <image
              href="/home/logo.png"
              x={path().cx - path().logo / 2}
              y={path().cy - path().logo / 2}
              width={path().logo}
              height={path().logo}
              preserveAspectRatio="xMidYMid meet"
            />
          </svg>
          <figcaption>Scan with the phone camera.</figcaption>
        </figure>
      )}
    </Show>
  );
}

function boxSuggestions(boxes, draft) {
  const q = String(draft || '').trim().toLowerCase();
  const list = Array.isArray(boxes) ? boxes : [];
  if (!q) return list.slice(0, 8);
  return list.filter((name) => name.toLowerCase().includes(q)).slice(0, 8);
}

/**
 * Batch defaults strip: game, language, condition, finish, flags, location
 * (+ stack setup behind the gear) and merge repeats. `onChange(patch, { stackOff })`
 * patches the batch defaults and names the stack-setup switch with it;
 * `locationRef` / `stackButtonRef` receive the elements the Alt shortcuts focus;
 * `cursorForStack(stack)` answers with the stack and position the desk really
 * uses (stock in the box plus this batch); `suggestion` is the box the desk
 * would put in an empty Location, shown as a suggestion and never written by
 * this bar; `stackOff` is the seller's switch and `onTouched()` tells the desk
 * the seller has got hold of the Location field; `api` receives
 * `{ commitLocation }` so the desk can apply what is being typed before it
 * creates a row with the box from before.
 * `pricing` (the `fetchPricingStrategies` answer) fills
 * the Pricing select, last in the row, when `showPricing` (listing for sale).
 */
export function DefaultsBar(props) {
  const d = () => props.defaults;
  const size = () => Math.max(1, Math.trunc(Number(d().stackSize)) || 1);
  const [locationDraft, setLocationDraft] = createSignal(untrack(() => d().location));
  const [boxMenuOpen, setBoxMenuOpen] = createSignal(false);
  const [boxActive, setBoxActive] = createSignal(0);
  const [stackDraft, setStackDraft] = createSignal(untrack(() => String(d().stack ?? 1)));
  const [posDraft, setPosDraft] = createSignal(untrack(() => String(d().startPosition ?? 1)));
  const [sizeDraft, setSizeDraft] = createSignal(untrack(() => String(size())));
  const [sizeOpen, setSizeOpen] = createSignal(false);
  /** Which draft field the seller has a hand on; only then does their text win over an answer. */
  const [editingField, setEditingField] = createSignal('');
  let sizeMenu;
  const pricingList = createMemo(() => pricingOptions(props.pricing, d(), props.currencyCtx));
  const stackOff = () => props.stackOff === true;
  const locationOff = () => isLocationOff(d());
  const gear = () => gearState({
    off: stackOff(),
    size: size(),
    stack: d().stack ?? 1,
    startPosition: d().startPosition ?? 1,
    locationOff: locationOff(),
  });
  const locationState = () => locationFieldState({ location: d().location, suggestion: props.suggestion || '' });
  /** The box the desk would stamp on the next card, as typed here. */
  const locationPatch = (value) => (String(value || '').trim() ? { location: String(value) } : LOCATION_OFF_PATCH);
  // What the bar last handed the desk: an answer for a value already on its
  // way must not re-arm the pause, and neither must a flush from the desk.
  let locationSent = String(untrack(() => d().location ?? ''));

  createEffect(sizeOpen, (open) => {
    if (!open) return undefined;
    const onDoc = (event) => {
      if (sizeMenu && !sizeMenu.contains(event.target)) setSizeOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  });
  // An answer only repaints a field the seller is not working in. A defaults
  // write that came back while the box was still being typed used to copy its
  // own value over the text — the seed did the same, and the seller lost the
  // location they had chosen.
  createEffect(() => d().location, (location) => {
    if (editingField() !== 'location') locationSent = String(location ?? '');
    setLocationDraft((current) => draftValue({ focused: editingField() === 'location', draft: current, serverValue: location }));
  });
  createEffect(() => [d().stack, d().location], ([stack]) => {
    setStackDraft((current) => draftValue({ focused: editingField() === 'stack', draft: current, serverValue: String(stack ?? 1) }));
  });
  createEffect(() => [d().startPosition, d().location, d().stack], ([start]) => {
    setPosDraft((current) => draftValue({ focused: editingField() === 'position', draft: current, serverValue: String(start ?? 1) }));
  });
  createEffect(size, (next) => {
    setSizeDraft((current) => draftValue({ focused: editingField() === 'size', draft: current, serverValue: String(next) }));
  });

  const applyLocation = (next) => {
    const value = String(next ?? '');
    if (value === locationSent) return undefined;
    locationSent = value;
    setLocationDraft(value);
    return props.onChange(locationPatch(value));
  };
  const suggestions = () => boxSuggestions(props.boxes || [], locationDraft());
  const showBoxMenu = () => {
    const list = suggestions();
    const draftBox = String(locationDraft() || '').trim().toLowerCase();
    return boxMenuOpen() && list.length > 0 && !(list.length === 1 && list[0].toLowerCase() === draftBox);
  };
  const pickBox = (name) => {
    setLocationDraft(name);
    setBoxMenuOpen(false);
    if (name !== d().location) {
      props.onTouched?.();
      return applyLocation(name);
    }
    return undefined;
  };
  const commitLocation = () => {
    const next = pendingDraft({ draft: locationDraft(), applied: locationSent });
    return next === null ? undefined : applyLocation(next);
  };
  // The desk applies a typed box before it creates a row: a scan or a card
  // added from search must not land in the box from before the typing.
  props.api?.({ commitLocation });
  // Giuseppe 2026-10-04: the location applies while typing — a short pause is
  // enough, no Enter. Blur and Enter still commit immediately.
  createEffect(() => [locationDraft(), d().location], ([draft, location]) => {
    if (draft === location || draft === locationSent) return undefined;
    const t = setTimeout(() => applyLocation(draft), 700);
    return () => clearTimeout(t);
  });
  const commitStack = () => {
    const n = Number.parseInt(stackDraft(), 10);
    const stack = d().stack ?? 1;
    if (!(n >= 1 && n <= 9999)) {
      setStackDraft(String(stack));
      return;
    }
    if (size() === 1) {
      if (n !== stack) props.onChange({ stack: n, startPosition: 1 });
      return;
    }
    // Typing a stack that already holds cards (even the current one) continues
    // after them; a full one walks on to the next stack with room. The desk
    // answers with both numbers, so the setup shows the cursor it really took.
    const cursor = props.cursorForStack(n) || { stack: n, startPosition: 1 };
    if (cursor.stack !== stack || cursor.startPosition !== (d().startPosition ?? 1)) props.onChange(cursor);
    else setStackDraft(String(stack));
  };
  const commitPos = () => {
    const n = Number.parseInt(posDraft(), 10);
    if (n >= 1 && n <= size() && n !== (d().startPosition ?? 1)) props.onChange({ startPosition: n });
    else setPosDraft(String(d().startPosition ?? 1));
  };
  const chooseSize = (nextSize) => {
    setSizeDraft(String(nextSize));
    // Off has to be switched off even when the size it fell back to is the one
    // being clicked: "1 card" after "Off" is a different choice than "1 card".
    if (nextSize === size() && !stackOff()) return undefined;
    // Cards per stack is only the divider. Remapping the absolute index
    // sent a stack-4 cursor back into an earlier stack.
    return props.onChange({ stackSize: nextSize }, { stackOff: false });
  };
  /** Off: the box name only, no divider and no position, until a size is picked. */
  const chooseStackOff = () => {
    if (stackOff()) return undefined;
    setSizeDraft('');
    return props.onChange(STACK_OFF_PATCH, { stackOff: true });
  };
  const commitSize = () => {
    // An emptied field and left is the seller asking for no stack setup, not
    // "keep the number that was there": the server keeps the old size for a
    // value it cannot parse, so the desk has to say Off itself.
    const decision = sizeCommit(sizeDraft());
    if (decision.kind === 'off') return chooseStackOff();
    if (decision.kind === 'invalid') {
      setSizeDraft(String(size()));
      return undefined;
    }
    return chooseSize(decision.size);
  };
  const blurOnEnter = (event) => {
    if (event.key === 'Enter') event.currentTarget.blur();
  };
  const digits = (event) => event.currentTarget.value.replace(/\D/g, '').slice(0, 4);

  return (
    <section class={['scan-defaults', { 'is-stack-full': props.stackFull }]} aria-labelledby="scan-defaults-title">
      <h2 id="scan-defaults-title" class="scan-defaults-label" title="Changing these updates every card in this batch, and the next scan. Shift + a row key changes them.">Batch defaults</h2>
      <div class="scan-defaults-row">
        {/* The TCG is the pokoin.com/{slug} prefix. Pokemon has no prefix. */}
        <label class="sd-field sd-game" title="Switch TCG — phone catalog follows this">
          <span>Game</span>
          <select
            value={gameIdFromHost()}
            onChange={(e) => {
              const next = e.currentTarget.value;
              if (next === gameIdFromHost()) return;
              setScanGameOverride(next);
              const base = gameBasename();
              const path = window.location.pathname;
              const rest = base && path.startsWith(base) ? (path.slice(base.length) || '/') : path;
              const slug = GAMES[next]?.slug || '';
              const tail = rest.startsWith('/') ? rest : `/${rest}`;
              window.location.assign(`${slug ? `/${slug}` : ''}${tail}`);
            }}
          >
            <For each={Object.values(GAMES)}>{(g) => <option value={g.id}>{g.name}</option>}</For>
          </select>
        </label>
        <label class="sd-field">
          <span>Language</span>
          <select value={d().language} onChange={(e) => props.onChange({ language: e.currentTarget.value })}>
            <For each={LANGUAGES}>{(code) => <option value={code}>{code}</option>}</For>
          </select>
        </label>
        <div class="sd-seg" role="group" aria-label="Condition">
          <For each={CONDITIONS}>
            {(c) => (
              <button
                type="button"
                class={d().condition === c ? 'on' : ''}
                aria-pressed={String(d().condition === c)}
                onClick={() => props.onChange({ condition: c })}
              >
                {c}
              </button>
            )}
          </For>
        </div>
        <label class="sd-field">
          <span>Finish</span>
          <select value={d().foilState} onChange={(e) => props.onChange({ foilState: e.currentTarget.value })}>
            <For each={FINISHES}>{(f) => <option value={f.value}>{f.label}</option>}</For>
          </select>
        </label>
        <div class="sd-seg" role="group" aria-label="Flags">
          <For each={['firstEdition', 'signed', 'altered']}>
            {(field) => (
              <button
                type="button"
                class={d()[field] ? 'on' : ''}
                aria-pressed={String(Boolean(d()[field]))}
                onClick={() => props.onChange({ [field]: !d()[field] })}
              >
                {FIELD_LABEL[field]}
              </button>
            )}
          </For>
        </div>
        {/* Location + gear: the stack setup (cards per stack, stack, position)
            lives behind the gear, not on the bar. Every scan is one card. */}
        <div ref={(el) => { sizeMenu = el; }} class={['sd-field grow sd-location', { 'is-full': props.stackFull, 'is-off': locationState().off }]}>
          <label for="scan-default-location">Location</label>
          <span class="sd-location-input">
            <input
              id="scan-default-location"
              ref={(el) => props.locationRef?.(el)}
              value={locationDraft()}
              maxlength={64}
              placeholder={locationState().placeholder}
              title={locationState().title}
              autocomplete="off"
              role="combobox"
              aria-expanded={String(showBoxMenu())}
              aria-controls="scan-box-suggestions"
              aria-autocomplete="list"
              onInput={(e) => {
                setLocationDraft(e.currentTarget.value);
                setBoxActive(0);
                setBoxMenuOpen(true);
                // Typing here is the seller choosing a box: the seed has had
                // its say and stays out of the rest of this batch.
                props.onTouched?.();
              }}
              onFocus={() => { setEditingField('location'); setBoxMenuOpen(true); setBoxActive(0); props.onTouched?.(); }}
              onBlur={() => {
                setEditingField('');
                setBoxMenuOpen(false);
                commitLocation();
              }}
              onKeyDown={(e) => {
                if (showBoxMenu()) {
                  const list = suggestions();
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setBoxActive((i) => Math.min(list.length - 1, i + 1));
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setBoxActive((i) => Math.max(0, i - 1));
                    return;
                  }
                  if (e.key === 'Enter' && list[boxActive()]) {
                    e.preventDefault();
                    pickBox(list[boxActive()]);
                    return;
                  }
                  if (e.key === 'Escape') {
                    setBoxMenuOpen(false);
                    return;
                  }
                }
                blurOnEnter(e);
              }}
            />
            <button
              ref={(el) => props.stackButtonRef?.(el)}
              type="button"
              class={['sd-gear', { 'is-off': gear().greyed }]}
              aria-haspopup="dialog"
              aria-expanded={String(sizeOpen())}
              aria-label="Stack setup"
              title={gear().title}
              onClick={() => setSizeOpen((open) => !open)}
            >
              <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z" />
              </svg>
              <Show when={gear().showSize}><b class="sd-gear-size">{size()}</b></Show>
            </button>
          </span>
          <Show when={showBoxMenu()}>
            <ul id="scan-box-suggestions" class="sd-box-menu" role="listbox">
              <For each={suggestions()}>
                {(name, i) => (
                  <li role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={String(i() === boxActive())}
                      class={i() === boxActive() ? 'on' : ''}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setBoxActive(i())}
                      onClick={() => pickBox(name)}
                    >
                      {name}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={sizeOpen()}>
            <div class="sd-stack-menu" role="dialog" aria-label="Stack setup">
              <p class="sd-stack-help">How many cards fit in one stack between two dividers. Each scan is one card; the slot counts up by itself. Off keeps the box name on its own.</p>
              <label class="sd-stack-row">
                <span>Cards per stack</span>
                <input
                  inputmode="numeric"
                  value={sizeDraft()}
                  aria-label="Cards per stack"
                  title={gear().greyed ? gear().title : 'Leave it empty and Off takes over: no stack, no position.'}
                  readOnly={gear().greyed}
                  aria-disabled={String(gear().greyed)}
                  onFocus={() => setEditingField('size')}
                  onInput={(e) => setSizeDraft(digits(e))}
                  onBlur={(e) => { setEditingField(''); commitSize(); }}
                  onKeyDown={blurOnEnter}
                />
              </label>
              <div class="sd-stack-chips" role="group" aria-label="Common stack sizes">
                <button
                  type="button"
                  aria-pressed={String(stackOff())}
                  class={stackOff() ? 'on' : ''}
                  title={stackOff()
                    ? 'Stack setup is Off — cards keep the box name only. Pick a size to switch it on.'
                    : 'Switch the stack setup off: no divider number on any card of this batch.'}
                  onClick={chooseStackOff}
                >
                  Off
                </button>
                <For each={STACK_SIZES}>
                  {(n) => (
                    <button
                      type="button"
                      aria-pressed={String(!stackOff() && n === size())}
                      class={!stackOff() && n === size() ? 'on' : ''}
                      onClick={() => chooseSize(n)}
                    >
                      {n === 1 ? '1 card' : n}
                    </button>
                  )}
                </For>
              </div>
              <label class="sd-stack-row">
                <span>Current stack</span>
                <input
                  inputmode="numeric"
                  value={stackDraft()}
                  aria-label="Current stack"
                  title={gear().greyed ? gear().title : 'The divider the next card of this batch goes after.'}
                  readOnly={gear().greyed}
                  aria-disabled={String(gear().greyed)}
                  onFocus={() => setEditingField('stack')}
                  onInput={(e) => setStackDraft(digits(e))}
                  onBlur={(e) => { setEditingField(''); commitStack(); }}
                  onKeyDown={blurOnEnter}
                />
              </label>
              <Show when={size() > 1}>
                <label class="sd-stack-row">
                  <span>Next position</span>
                  <input
                    inputmode="numeric"
                    value={posDraft()}
                    aria-label="Next position in the stack"
                    title={gear().greyed ? gear().title : 'The place the next card takes inside that stack.'}
                    readOnly={gear().greyed}
                    aria-disabled={String(gear().greyed)}
                    onFocus={() => setEditingField('position')}
                    onInput={(e) => setPosDraft(digits(e))}
                    onBlur={(e) => { setEditingField(''); commitPos(); }}
                    onKeyDown={blurOnEnter}
                  />
                </label>
              </Show>
              <button type="button" class="btn ghost sd-stack-done" onClick={() => setSizeOpen(false)}>Done</button>
            </div>
          </Show>
        </div>
        <label class="sd-check" title="Consecutive identical scans raise the quantity of one row">
          <input type="checkbox" checked={Boolean(d().mergeRepeats)} onChange={(e) => props.onChange({ mergeRepeats: e.currentTarget.checked })} />
          <span>Merge repeats</span>
        </label>
        <Show when={props.showPricing}>
          <label class="sd-field sd-pricing">
            <span>Pricing</span>
            <select
              value={pricingChoiceValue(d())}
              data-testid="scan-pricing"
              onChange={(e) => {
                const next = e.currentTarget.value;
                if (next !== pricingChoiceValue(d())) props.onChange(pricingChoicePatch(next));
              }}
            >
              <Show when={pricingList().groups.length}>
                <optgroup label="Add to a group">
                  <For each={pricingList().groups}>{(o) => <option value={o.value}>{o.label}</option>}</For>
                </optgroup>
              </Show>
              <Show when={pricingList().strategies.length}>
                <optgroup label="Price once with a strategy">
                  <For each={pricingList().strategies}>{(o) => <option value={o.value}>{o.label}</option>}</For>
                </optgroup>
              </Show>
              <option value="">Suggested prices</option>
            </select>
          </label>
          <a class="sd-pricing-manage" href={props.pricingHref || '/mypokoin/pricer'}>Manage pricing</a>
        </Show>
      </div>
      <Show when={props.showPricing && pricingHint(d())}>
        <p class="sd-pricing-hint">{pricingHint(d())}</p>
      </Show>
      <Show when={props.stackFull}>
        <p class="sd-stack-full-msg" role="status">Stack full — next card starts a new divider.</p>
      </Show>
    </section>
  );
}

export function HelpOverlay(props) {
  return (
    <div class="scan-modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onMouseDown={() => props.onClose()}>
      <div class="scan-modal-box scan-help" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        <p class="scan-help-note">
          PowerTools single-card: after you pick a printing, Qty is focused and the on-screen
          key legend lights up — click a key or type it. Digits type quantity; Enter creates;
          C creates &amp; copies. Queue keys work when no text field is focused.
        </p>
        <div class="scan-help-grid">
          <For each={HELP_SECTIONS}>
            {(section) => (
              <section>
                <h3>{section.title}</h3>
                <dl>
                  <For each={section.rows}>
                    {([keys, text]) => (
                      <div>
                        <dt><kbd>{keys}</kbd></dt>
                        <dd>{text}</dd>
                      </div>
                    )}
                  </For>
                </dl>
              </section>
            )}
          </For>
        </div>
        <button type="button" class="btn ghost" onClick={() => props.onClose()}>Close (Esc)</button>
      </div>
    </div>
  );
}

/** ?perf=1 timing panel; `now` (the desk's 1 s clock) re-reads the samples. */
export function PerfPanel(props) {
  const view = createMemo(() => {
    props.now;
    const samples = perfSink();
    return {
      rows: perfRows(samples),
      start: [...samples].reverse().find((s) => s.kind === 'desk-start'),
      batch: [...samples].reverse().find((s) => s.kind === 'desk-batch'),
    };
  });
  return (
    <aside class="scan-perf" data-now={props.now}>
      <Show when={view().start}>
        {(start) => (
          <span>
            desk-start: token={start().tokenMs ?? '—'}ms session={start().startMs ?? '—'}ms
            {start().pairing ? ' pairing=yes' : ' pairing=no'}
          </span>
        )}
      </Show>
      <Show when={view().batch}>
        {(batch) => <span>desk-batch: {batch().batchMs ?? '—'}ms items={batch().items ?? 0}</span>}
      </Show>
      <For each={view().rows}>
        {([key, n, med, p]) => <span>{key}: n={n} p50={med ?? '—'} p95={p ?? '—'}</span>}
      </For>
    </aside>
  );
}

/** Confirm dialog wrapper: focuses its primary button on open (React autoFocus),
 * so Enter is a native click on it. */
export function AutoFocusButton(props) {
  let el;
  onSettled(() => {
    el?.focus();
  });
  return (
    <button ref={(node) => { el = node; }} type="button" class={props.class} onClick={(e) => props.onClick(e)} disabled={props.disabled}>
      {props.children}
    </button>
  );
}
