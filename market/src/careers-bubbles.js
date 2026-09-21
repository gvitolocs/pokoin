// "Life at Pokoin" bubbles: a slow drift inside the stage, soft collisions,
// and pointer drag with a gentle throw. The CSS slot layout is each bubble's
// starting point; the driver only adds a transform on top of it.

/** Cruise speed of a free bubble, px per second. */
export const DRIFT_SPEED = 9;
/** A thrown bubble never leaves faster than this, px per second. */
export const MAX_THROW = 280;
/** Per second: how quickly a thrown (or pushed) bubble eases back to cruise. */
const SETTLE = 1.4;
/** Longest simulated frame, so a background tab does not teleport bubbles. */
const MAX_DT = 0.05;

/** Starting velocity: cruise speed in a random direction. */
export function driftVelocity(speed = DRIFT_SPEED, random = Math.random) {
  const angle = random() * Math.PI * 2;
  return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
}

/** Caps a throw velocity at MAX_THROW, keeping its direction. */
export function capThrow(vx, vy, max = MAX_THROW) {
  const speed = Math.hypot(vx, vy);
  if (!(speed > max)) return { vx, vy };
  return { vx: (vx / speed) * max, vy: (vy / speed) * max };
}

/**
 * One simulation step, in place. bodies: [{ x, y, r, vx, vy, dragging }]
 * with x/y the centre in stage pixels. A dragged body is held by the pointer:
 * it does not move here and pushes the others out of its way.
 */
export function stepBubbles(bodies, dt, width, height, cruise = DRIFT_SPEED) {
  const t = Math.min(Math.max(dt, 0), MAX_DT);
  for (const b of bodies) {
    if (b.dragging) continue;
    const speed = Math.hypot(b.vx, b.vy);
    const next = speed + (cruise - speed) * Math.min(1, SETTLE * t);
    if (speed > 0) {
      b.vx *= next / speed;
      b.vy *= next / speed;
    } else if (next > 0) {
      Object.assign(b, driftVelocity(next));
    }
    b.x += b.vx * t;
    b.y += b.vy * t;
    keepInside(b, width, height);
  }
  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      collide(bodies[i], bodies[j]);
    }
  }
  for (const b of bodies) {
    if (!b.dragging) keepInside(b, width, height);
  }
  return bodies;
}

function keepInside(b, width, height) {
  if (b.x - b.r < 0) {
    b.x = b.r;
    b.vx = Math.abs(b.vx);
  } else if (b.x + b.r > width) {
    b.x = width - b.r;
    b.vx = -Math.abs(b.vx);
  }
  if (b.y - b.r < 0) {
    b.y = b.r;
    b.vy = Math.abs(b.vy);
  } else if (b.y + b.r > height) {
    b.y = height - b.r;
    b.vy = -Math.abs(b.vy);
  }
}

function collide(a, b) {
  if (a.dragging && b.dragging) return;
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let dist = Math.hypot(dx, dy);
  const min = a.r + b.r;
  if (dist >= min) return;
  if (dist === 0) {
    dx = 1;
    dy = 0;
    dist = 1;
  }
  const nx = dx / dist;
  const ny = dy / dist;
  const overlap = min - dist;
  // Separate: a held bubble stays under the pointer, the other gives way.
  const shareA = a.dragging ? 0 : b.dragging ? 1 : 0.5;
  const shareB = 1 - shareA;
  a.x -= nx * overlap * shareA;
  a.y -= ny * overlap * shareA;
  b.x += nx * overlap * shareB;
  b.y += ny * overlap * shareB;
  // Closing speed along the contact normal (negative = approaching).
  const closing = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (closing >= 0) return;
  if (a.dragging) {
    b.vx -= 2 * closing * nx;
    b.vy -= 2 * closing * ny;
  } else if (b.dragging) {
    a.vx += 2 * closing * nx;
    a.vy += 2 * closing * ny;
  } else {
    // Equal masses: swap the normal components.
    a.vx += closing * nx;
    a.vy += closing * ny;
    b.vx -= closing * nx;
    b.vy -= closing * ny;
  }
}

/**
 * Brings the bubbles inside `container` to life. Returns a cleanup function.
 * Bubbles are its visible `.careers-media-art` children.
 */
export function startBubbleDrift(container, {
  reducedMotion = false,
  random = Math.random,
} = {}) {
  if (!container || typeof window === 'undefined') return () => {};
  const cruise = reducedMotion ? 0 : DRIFT_SPEED;
  let bodies = [];
  let width = 0;
  let height = 0;
  let frame = 0;
  let last = 0;
  let visible = true;

  function measure() {
    width = container.clientWidth;
    height = container.clientHeight;
    const previous = new Map(bodies.map((b) => [b.el, b]));
    bodies = [...container.querySelectorAll('.careers-media-art')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => {
        const r = el.offsetWidth / 2;
        // offsetLeft/Top ignore transforms: the CSS slot is the home position.
        const homeX = el.offsetLeft + r;
        const homeY = el.offsetTop + r;
        const old = previous.get(el);
        const body = old
          ? { ...old, r, homeX, homeY }
          : { el, r, homeX, homeY, x: homeX, y: homeY, dragging: false, ...driftVelocity(cruise, random) };
        keepInside(body, width, height);
        return body;
      });
    for (const el of container.querySelectorAll('.careers-media-art')) {
      if (el.offsetParent === null) el.style.transform = '';
    }
    render();
  }

  function render() {
    for (const b of bodies) {
      b.el.style.transform = `translate3d(${(b.x - b.homeX).toFixed(2)}px, ${(b.y - b.homeY).toFixed(2)}px, 0)`;
    }
  }

  function tick(now) {
    frame = 0;
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    stepBubbles(bodies, dt, width, height, cruise);
    render();
    schedule();
  }

  function schedule() {
    if (!frame && visible) frame = window.requestAnimationFrame(tick);
  }

  function stop() {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
  }

  // ---------------------------------------------------------------- drag
  let drag = null;

  function stagePoint(event) {
    const rect = container.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onPointerDown(event) {
    const el = event.currentTarget;
    const body = bodies.find((b) => b.el === el);
    if (!body || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    const p = stagePoint(event);
    drag = { body, pointerId: event.pointerId, dx: p.x - body.x, dy: p.y - body.y, lastX: p.x, lastY: p.y, lastT: event.timeStamp, vx: 0, vy: 0 };
    body.dragging = true;
    body.vx = 0;
    body.vy = 0;
    el.classList.add('is-dragging');
    try {
      el.setPointerCapture(event.pointerId);
    } catch (_) {
      // Capture is a nicety (drag keeps working while over the same bubble).
    }
    schedule();
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const p = stagePoint(event);
    const { body } = drag;
    body.x = Math.min(Math.max(p.x - drag.dx, body.r), width - body.r);
    body.y = Math.min(Math.max(p.y - drag.dy, body.r), height - body.r);
    const elapsed = (event.timeStamp - drag.lastT) / 1000;
    if (elapsed > 0) {
      // Smoothed pointer velocity, for the throw on release.
      drag.vx = drag.vx * 0.6 + ((p.x - drag.lastX) / elapsed) * 0.4;
      drag.vy = drag.vy * 0.6 + ((p.y - drag.lastY) / elapsed) * 0.4;
    }
    drag.lastX = p.x;
    drag.lastY = p.y;
    drag.lastT = event.timeStamp;
    render();
  }

  function onPointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { body } = drag;
    body.dragging = false;
    // A pointer that stopped before release drops the bubble in place.
    const still = event.timeStamp - drag.lastT > 80;
    Object.assign(body, still ? { vx: 0, vy: 0 } : capThrow(drag.vx, drag.vy));
    body.el.classList.remove('is-dragging');
    drag = null;
    schedule();
  }

  const elements = [...container.querySelectorAll('.careers-media-art')];
  for (const el of elements) {
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
  }

  container.classList.add('is-live');
  measure();

  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : null;
  resize?.observe(container);
  // Only simulate while the tile is on screen.
  const seen = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) schedule();
      else stop();
    })
    : null;
  seen?.observe(container);
  schedule();

  return () => {
    stop();
    resize?.disconnect();
    seen?.disconnect();
    for (const el of elements) {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.classList.remove('is-dragging');
      el.style.transform = '';
    }
    container.classList.remove('is-live');
  };
}
