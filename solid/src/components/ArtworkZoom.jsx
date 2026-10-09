import { createEffect, createSignal, onSettled, Show } from 'solid-js';
import { Portal } from '@solidjs/web';
import { artCutVars } from '@market/art-cut.js';
import { cdnFetchUrl, homepageDerivativeUrl, preferFullImage } from '@market/image-urls.js';
import { scanZoomBox, SCAN_ZOOM_DELAY_MS } from '@market/scan-thumb-zoom.js';
import { suggestHoverAllowed } from '@market/suggest-hover.js';
import CardArt from './CardArt.jsx';

/**
 * CardTrader-style hover zoom (market/src/components/ThumbZoom.jsx): wrap a
 * small thumbnail; on hover (fine pointer, desktop viewports) the full scan
 * floats beside the cursor in a fixed `.suggest-hover` portal.
 */
export function ThumbZoom(props) {
  const [box, setBox] = createSignal(null);
  let pointer = { x: 0, y: 0 };
  let timer = null;
  let portal;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function hide() {
    clearTimer();
    setBox(null);
  }

  function place(x, y) {
    pointer = { x, y };
    setBox(scanZoomBox({
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      pointerX: x,
      pointerY: y,
      maxHeight: props.maxHeight,
    }));
  }

  function enter(event) {
    if (props.disabled || !props.src) return;
    if (!suggestHoverAllowed(window.innerWidth, window.matchMedia?.('(hover: hover)').matches)) return;
    pointer = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      timer = null;
      place(pointer.x, pointer.y);
    }, SCAN_ZOOM_DELAY_MS);
  }

  function move(event) {
    pointer = { x: event.clientX, y: event.clientY };
    if (box() && !props.footer) place(event.clientX, event.clientY);
  }

  function leave(event) {
    const next = event.relatedTarget;
    if (next && portal?.contains(next)) return;
    hide();
  }

  function click(event) {
    if (!props.openOnClick || props.disabled || !props.src) return;
    if (event.target?.closest?.('a, button, input, select, textarea, label')) return;
    event.preventDefault();
    event.stopPropagation();
    clearTimer();
    place(event.clientX, event.clientY);
  }

  // Scrolling (desk table or page) un-anchors the fixed box — hide instead of chase.
  createEffect(() => Boolean(box()), (open) => {
    if (!open) return undefined;
    window.addEventListener('scroll', hide, { capture: true, passive: true });
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('scroll', hide, { capture: true });
      window.removeEventListener('blur', hide);
    };
  });

  onSettled(() => {
    const onStart = () => {
      clearTimer();
      document.documentElement.classList.add('is-card-dragging');
    };
    const onEnd = () => {
      document.documentElement.classList.remove('is-card-dragging');
      hide();
    };
    window.addEventListener('dragstart', onStart, true);
    window.addEventListener('dragend', onEnd, true);
    return () => {
      clearTimer();
      window.removeEventListener('dragstart', onStart, true);
      window.removeEventListener('dragend', onEnd, true);
    };
  });

  return (
    <span
      class="thumb-zoom-host"
      onMouseEnter={enter}
      onMouseMove={move}
      onMouseLeave={leave}
      onClick={click}
    >
      {props.children}
      <Show when={box() && props.src}>
        <Portal mount={document.body}>
          <div
            ref={(el) => { portal = el; }}
            class="suggest-hover"
            style={{
              left: `${box()?.left ?? 0}px`,
              top: `${box()?.top ?? 0}px`,
              width: `${box()?.width ?? 0}px`,
              height: `${box()?.height ?? 0}px`,
            }}
            aria-hidden={props.footer ? undefined : 'true'}
            onMouseLeave={(event) => {
              const next = event.relatedTarget;
              if (next && event.currentTarget.contains(next)) return;
              hide();
            }}
          >
            <CardArt src={props.src} full={props.full ?? true} alt={props.alt || ''} />
            {props.footer}
          </div>
        </Portal>
      </Show>
    </span>
  );
}

/**
 * Illustration window in a row (market/src/components/ArtworkZoom.jsx). Hover
 * floats the full scan at the shared shop/cart size.
 */
export default function ArtworkZoom(props) {
  const full = () => preferFullImage(props.src) || props.src;
  const thumb = () => homepageDerivativeUrl(props.src) || full();
  return (
    <Show when={full()}>
      <ThumbZoom src={full()} full alt={props.alt || props.name || ''}>
        <span class="art-cut" style={artCutVars({ name: props.name || '', set: props.set || '', expansion: props.set || '' }, 'album')}>
          <img
            src={cdnFetchUrl(thumb())}
            alt=""
            draggable="false"
            onError={(event) => {
              const img = event.currentTarget;
              if (!img || img.dataset.fallback) return;
              img.dataset.fallback = '1';
              img.src = cdnFetchUrl(full());
            }}
          />
        </span>
      </ThumbZoom>
    </Show>
  );
}
