/** Pointer-drag state machine for moving a card between two columns. */

export const DRAG_MOVE_THRESHOLD_PX = 6;
export const DRAG_LONG_PRESS_MS = 250;

export function initialDrag() {
  return {
    phase: 'idle',
    pointerId: null,
    pointerType: '',
    originX: 0,
    originY: 0,
    x: 0,
    y: 0,
    startedAt: 0,
    from: null,
    over: null,
    payload: null,
  };
}

export function dragDistance(origin, point) {
  const dx = Number(point?.x) - Number(origin?.x);
  const dy = Number(point?.y) - Number(origin?.y);
  return Math.hypot(dx, dy);
}

export function passedMoveThreshold(origin, point, threshold = DRAG_MOVE_THRESHOLD_PX) {
  return dragDistance(origin, point) >= threshold;
}

/**
 * Last containing zone wins so a nested or later column paints on top.
 * `zones` items are `{ id, left, top, right, bottom }`.
 */
export function hitTestZone(zones, x, y) {
  if (!Array.isArray(zones)) return null;
  let hit = null;
  for (const zone of zones) {
    if (!zone || zone.id == null) continue;
    if (x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom) hit = zone.id;
  }
  return hit;
}

/** A drop counts only when it lands on the other column. */
export function dropTarget(from, over) {
  if (from == null || over == null || from === over) return null;
  return over;
}

export function gestureShouldLift(state, point, now = point?.now) {
  if (!state || state.phase !== 'pending') return false;
  if (passedMoveThreshold(
    { x: state.originX, y: state.originY },
    point,
  )) return true;
  return state.pointerType === 'touch'
    && typeof now === 'number'
    && typeof state.startedAt === 'number'
    && now - state.startedAt >= DRAG_LONG_PRESS_MS;
}

function samePointer(state, event) {
  return event?.pointerId == null || state.pointerId == null || event.pointerId === state.pointerId;
}

/**
 * @returns {{ state: object, action: null | { type: string, from?: string, to?: string, payload?: unknown } }}
 * action.type is `capture`, `lift`, `move`, or `cancel`.
 */
export function reduceDragMove(state, event) {
  const current = state || initialDrag();
  const type = event?.type;

  if (type === 'down') {
    if (current.phase !== 'idle') return { state: current, action: null };
    return {
      state: {
        phase: 'pending',
        pointerId: event.pointerId ?? null,
        pointerType: event.pointerType || 'mouse',
        originX: event.x,
        originY: event.y,
        x: event.x,
        y: event.y,
        startedAt: event.now ?? 0,
        from: event.from ?? null,
        over: event.from ?? null,
        payload: event.payload ?? null,
      },
      action: { type: 'capture' },
    };
  }

  if (!samePointer(current, event)) return { state: current, action: null };

  if (type === 'move') {
    if (current.phase === 'idle') return { state: current, action: null };
    const next = {
      ...current,
      x: event.x,
      y: event.y,
      over: event.over !== undefined ? event.over : current.over,
    };
    if (current.phase === 'pending' && gestureShouldLift(current, event, event.now)) {
      return { state: { ...next, phase: 'dragging' }, action: { type: 'lift' } };
    }
    return { state: next, action: null };
  }

  if (type === 'longpress') {
    if (current.phase !== 'pending' || current.pointerType !== 'touch') {
      return { state: current, action: null };
    }
    return {
      state: {
        ...current,
        phase: 'dragging',
        over: event.over !== undefined ? event.over : current.over,
      },
      action: { type: 'lift' },
    };
  }

  if (type === 'up') {
    if (current.phase === 'idle') return { state: current, action: null };
    if (current.phase === 'dragging') {
      const over = event.over !== undefined ? event.over : current.over;
      const to = dropTarget(current.from, over);
      if (to) {
        return {
          state: initialDrag(),
          action: { type: 'move', from: current.from, to, payload: current.payload },
        };
      }
    }
    return { state: initialDrag(), action: { type: 'cancel' } };
  }

  if (type === 'cancel' || type === 'escape') {
    if (current.phase === 'idle') return { state: current, action: null };
    return { state: initialDrag(), action: { type: 'cancel' } };
  }

  return { state: current, action: null };
}
