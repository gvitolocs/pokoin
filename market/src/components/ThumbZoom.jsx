import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { suggestHoverAllowed } from '../suggest-hover.js';
import { scanZoomBox, SCAN_ZOOM_DELAY_MS } from '../scan-thumb-zoom.js';
import CardArt from './CardArt.jsx';

/**
 * CardTrader-style hover zoom: wrap a small thumbnail; on hover (fine pointer,
 * desktop viewports) the full-resolution leftover floats beside the cursor in
 * a fixed `.suggest-hover` portal. Pointer-following, one zoom per trigger.
 */
export default function ThumbZoom({
  src,
  full = true,
  alt = '',
  children,
  disabled = false,
  footer = null,
}) {
  const [box, setBox] = useState(null);
  const pointer = useRef({ x: 0, y: 0 });
  const timer = useRef(null);
  const portal = useRef(null);
  const srcRef = useRef(src);
  const footerRef = useRef(footer);
  srcRef.current = src;
  footerRef.current = footer;

  function hide() {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setBox(null);
  }

  function place(x, y) {
    pointer.current = { x, y };
    setBox(scanZoomBox({
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      pointerX: x,
      pointerY: y,
    }));
  }

  function enter(event) {
    if (disabled || !srcRef.current) {
      return;
    }
    if (!suggestHoverAllowed(window.innerWidth, window.matchMedia?.('(hover: hover)').matches)) {
      return;
    }
    pointer.current = { x: event.clientX, y: event.clientY };
    timer.current = setTimeout(() => {
      timer.current = null;
      place(pointer.current.x, pointer.current.y);
    }, SCAN_ZOOM_DELAY_MS);
  }

  function move(event) {
    pointer.current = { x: event.clientX, y: event.clientY };
    if (box && !footerRef.current) {
      place(event.clientX, event.clientY);
    }
  }

  function leave(event) {
    const next = event.relatedTarget;
    if (next && portal.current?.contains(next)) return;
    hide();
  }

  useEffect(() => {
    if (!box) {
      return undefined;
    }
    const onHide = () => hide();
    // Scrolling (desk table or page) un-anchors the fixed box — hide instead of chase.
    window.addEventListener('scroll', onHide, { capture: true, passive: true });
    window.addEventListener('blur', onHide);
    return () => {
      window.removeEventListener('scroll', onHide, { capture: true });
      window.removeEventListener('blur', onHide);
    };
  }, [box]);

  useEffect(() => hide, []);

  useEffect(() => {
    const onStart = () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
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
      window.removeEventListener('dragstart', onStart, true);
      window.removeEventListener('dragend', onEnd, true);
    };
  }, []);

  return (
    <span className="thumb-zoom-host" onMouseEnter={enter} onMouseMove={move} onMouseLeave={leave}>
      {children}
      {box && src
        ? createPortal(
          <div
            ref={portal}
            className="suggest-hover"
            style={{
              left: `${box.left}px`,
              top: `${box.top}px`,
              width: `${box.width}px`,
              height: `${box.height}px`,
            }}
            aria-hidden={footer ? undefined : 'true'}
            onMouseLeave={(event) => {
              const next = event.relatedTarget;
              if (next && event.currentTarget.contains(next)) return;
              hide();
            }}
          >
            <CardArt src={src} full={full} alt={alt} />
            {footer}
          </div>,
          document.body,
        )
        : null}
    </span>
  );
}
