import { createEffect, createSignal, onSettled, Show } from 'solid-js';
import { Portal } from '@solidjs/web';
import { scanZoomBox, SCAN_ZOOM_DELAY_MS } from '@market/scan-thumb-zoom.js';
import { suggestHoverAllowed } from '@market/suggest-hover.js';
import CardArt from './CardArt.jsx';

/**
 * CardTrader-style hover zoom (market/src/components/ThumbZoom.jsx): wrap a
 * small thumbnail; on hover (fine pointer, desktop viewports) the full scan
 * floats beside the cursor in a fixed `.suggest-hover` portal. The scroll /
 * blur dismiss listeners exist only while the zoom is shown.
 */
export default function ThumbZoom(props) {
  const [box, setBox] = createSignal(null);
  let pointer = { x: 0, y: 0 };
  let timer = null;
  let portal = null;

  function hide() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
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
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    place(event.clientX, event.clientY);
  }

  createEffect(() => Boolean(box()), (shown) => {
    if (!shown) return undefined;
    const onHide = () => hide();
    // Scrolling (desk table or page) un-anchors the fixed box — hide instead of chase.
    window.addEventListener('scroll', onHide, { capture: true, passive: true });
    window.addEventListener('blur', onHide);
    return () => {
      window.removeEventListener('scroll', onHide, { capture: true });
      window.removeEventListener('blur', onHide);
    };
  });

  onSettled(() => {
    const onStart = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      document.documentElement.classList.add('is-card-dragging');
    };
    const onEnd = () => {
      document.documentElement.classList.remove('is-card-dragging');
      hide();
    };
    window.addEventListener('dragstart', onStart, true);
    window.addEventListener('dragend', onEnd, true);
    return () => {
      hide();
      window.removeEventListener('dragstart', onStart, true);
      window.removeEventListener('dragend', onEnd, true);
    };
  });

  return (
    <span class="thumb-zoom-host" onMouseEnter={enter} onMouseMove={move} onMouseLeave={leave} onClick={click}>
      {props.children}
      <Show when={box() && props.src ? box() : null}>
        {(rect) => (
          <Portal mount={document.body}>
            <div
              ref={(el) => { portal = el; }}
              class="suggest-hover"
              style={{
                left: `${rect().left}px`,
                top: `${rect().top}px`,
                width: `${rect().width}px`,
                height: `${rect().height}px`,
              }}
              aria-hidden={props.footer ? undefined : 'true'}
              onMouseLeave={(event) => {
                const next = event.relatedTarget;
                if (next && event.currentTarget.contains(next)) return;
                hide();
              }}
            >
              <CardArt src={props.src} full={props.full ?? true} alt={props.alt ?? ''} />
              {props.footer}
            </div>
          </Portal>
        )}
      </Show>
    </span>
  );
}
