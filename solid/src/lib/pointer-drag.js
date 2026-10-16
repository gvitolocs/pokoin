import { createSignal, onCleanup } from 'solid-js';
import { DRAG_LONG_PRESS_MS, hitTestZone, initialDrag, reduceDragMove } from '@market/drag-move.js';
import { fillScanNode } from '../components/ScanImage.jsx';

const INTERACTIVE = 'button, input, select, textarea, a, label';

/**
 * Pointer Events drag shared by Collection and the Zero picking list.
 * The state machine lives in market/src/drag-move.js; this binds capture,
 * the long-press timer, the floating art ghost, and column hit-testing.
 */
export function createPointerDrag(options) {
  let current = initialDrag();
  const [view, setView] = createSignal(current);
  const zones = new Map();
  let pressTimer = 0;
  let captureEl = null;
  let ghost = null;
  let swallowClick = false;
  let touchBlock = null;
  let onKey = null;

  function publish(next) {
    const prev = current;
    current = next;
    if (prev.phase !== next.phase || prev.over !== next.over || prev.phase === 'idle') setView(next);
  }

  function zoneRects() {
    const list = [];
    for (const [id, element] of zones) {
      if (!element || !element.isConnected) continue;
      const rect = element.getBoundingClientRect();
      list.push({ id, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    }
    return list;
  }

  function overAt(x, y) {
    return hitTestZone(zoneRects(), x, y);
  }

  function clearTimer() {
    if (pressTimer) {
      window.clearTimeout(pressTimer);
      pressTimer = 0;
    }
  }

  function positionGhost() {
    if (!ghost) return;
    ghost.style.left = `${current.x}px`;
    ghost.style.top = `${current.y}px`;
  }

  function showGhost() {
    hideGhost();
    const payload = current.payload || {};
    const node = document.createElement('div');
    node.className = 'pokoin-drag-ghost';
    node.setAttribute('aria-hidden', 'true');
    fillScanNode(node, {
      src: payload.image,
      label: payload.label,
      letterClass: 'pokoin-drag-ghost-letter',
    });
    document.body.appendChild(node);
    ghost = node;
    positionGhost();
  }

  function hideGhost() {
    ghost?.remove();
    ghost = null;
  }

  function stopTouchBlock() {
    if (!touchBlock) return;
    window.removeEventListener('touchmove', touchBlock);
    touchBlock = null;
  }

  function stopKey() {
    if (!onKey) return;
    window.removeEventListener('keydown', onKey);
    onKey = null;
  }

  function endSession() {
    clearTimer();
    hideGhost();
    stopTouchBlock();
    stopKey();
    document.documentElement.classList.remove('is-pointer-dragging');
    if (captureEl) captureEl.style.touchAction = '';
    captureEl = null;
  }

  function lift() {
    document.documentElement.classList.add('is-pointer-dragging');
    if (captureEl) captureEl.style.touchAction = 'none';
    showGhost();
    if (!touchBlock) {
      touchBlock = (event) => {
        if (current.phase === 'dragging' && event.cancelable) event.preventDefault();
      };
      window.addEventListener('touchmove', touchBlock, { passive: false });
    }
  }

  function armSwallow() {
    swallowClick = true;
    window.setTimeout(() => { swallowClick = false; }, 400);
  }

  function apply(event) {
    const wasDragging = current.phase === 'dragging';
    const result = reduceDragMove(current, event);
    publish(result.state);
    if (result.action?.type === 'lift') lift();
    if (result.action?.type === 'move') {
      armSwallow();
      endSession();
      options.onMove?.(result.action);
    } else if (result.action?.type === 'cancel') {
      if (wasDragging) armSwallow();
      endSession();
    } else if (current.phase === 'dragging') {
      positionGhost();
    }
    return result;
  }

  function onPointerDown(domEvent, payload, from) {
    if (domEvent.button != null && domEvent.button !== 0) return;
    if (domEvent.target?.closest?.(INTERACTIVE)) return;
    if (current.phase !== 'idle') return;
    try { domEvent.currentTarget.setPointerCapture(domEvent.pointerId); } catch (_) { /* already gone */ }
    captureEl = domEvent.currentTarget;
    const now = performance.now();
    apply({
      type: 'down',
      pointerId: domEvent.pointerId,
      pointerType: domEvent.pointerType,
      x: domEvent.clientX,
      y: domEvent.clientY,
      now,
      from,
      payload,
    });
    if (!onKey) {
      onKey = (event) => {
        if (event.key !== 'Escape') return;
        apply({ type: 'escape', pointerId: current.pointerId });
      };
      window.addEventListener('keydown', onKey);
    }
    if (domEvent.pointerType === 'touch') {
      const pointerId = domEvent.pointerId;
      clearTimer();
      pressTimer = window.setTimeout(() => {
        pressTimer = 0;
        apply({
          type: 'longpress',
          pointerId,
          over: overAt(current.x, current.y),
        });
      }, DRAG_LONG_PRESS_MS);
    }
  }

  function onPointerMove(domEvent) {
    if (current.phase === 'idle' || domEvent.pointerId !== current.pointerId) return;
    const over = overAt(domEvent.clientX, domEvent.clientY);
    const result = apply({
      type: 'move',
      pointerId: domEvent.pointerId,
      x: domEvent.clientX,
      y: domEvent.clientY,
      now: performance.now(),
      over,
    });
    if (result.state.phase === 'dragging') clearTimer();
  }

  function onPointerUp(domEvent) {
    if (current.phase === 'idle' || domEvent.pointerId !== current.pointerId) return;
    clearTimer();
    const node = captureEl;
    apply({
      type: 'up',
      pointerId: domEvent.pointerId,
      x: domEvent.clientX,
      y: domEvent.clientY,
      over: overAt(domEvent.clientX, domEvent.clientY),
    });
    try { node?.releasePointerCapture?.(domEvent.pointerId); } catch (_) { /* already released */ }
  }

  function onPointerCancel(domEvent) {
    if (current.phase === 'idle') return;
    if (domEvent?.pointerId != null && domEvent.pointerId !== current.pointerId) return;
    apply({ type: 'cancel', pointerId: current.pointerId });
  }

  function setZone(id, element) {
    if (element) zones.set(id, element);
    else zones.delete(id);
  }

  function consumeClick() {
    if (!swallowClick) return false;
    swallowClick = false;
    return true;
  }

  onCleanup(() => {
    endSession();
    publish(initialDrag());
  });

  return {
    view,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    setZone,
    consumeClick,
  };
}
