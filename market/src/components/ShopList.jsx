import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { marqueeBlocked, marqueeRect, rectsIntersect } from '../shop-marquee.js';

const DRAG_THRESHOLD = 5;

/**
 * Shop rows. A press on empty space and a move draws a selection box and
 * highlights every row the box crosses.
 */
export default function ShopList({ className = '', children }) {
  const ref = useRef(null);
  const [band, setBand] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    const list = ref.current;
    const panel = list?.closest('.shop-panel') || list;
    if (!panel) return undefined;

    let origin = null;
    let armed = false;
    let base = new Set();

    function rowBoxes() {
      return [...(list?.querySelectorAll('.shop-row[data-listing-id]') || [])];
    }

    function paint(rect) {
      const next = new Set(base);
      for (const row of rowBoxes()) {
        const box = row.getBoundingClientRect();
        const hit = rectsIntersect(rect, {
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
        });
        const id = row.dataset.listingId;
        if (!id) continue;
        if (hit) next.add(id);
        else if (!origin?.additive) next.delete(id);
      }
      setSelected(next);
    }

    function onDown(event) {
      if (event.button !== 0) return;
      if (marqueeBlocked(event.target)) return;
      origin = {
        x: event.clientX,
        y: event.clientY,
        additive: event.ctrlKey || event.metaKey,
      };
      armed = false;
      base = origin.additive ? new Set(selectedRef.current) : new Set();
      event.preventDefault();
    }

    function onMove(event) {
      if (!origin) return;
      const rect = marqueeRect(origin.x, origin.y, event.clientX, event.clientY);
      if (!armed && Math.hypot(rect.width, rect.height) < DRAG_THRESHOLD) return;
      armed = true;
      document.documentElement.classList.add('is-shop-marquee');
      setBand(rect);
      paint(rect);
    }

    function onUp() {
      if (origin && !armed && !origin.additive) setSelected(new Set());
      origin = null;
      armed = false;
      setBand(null);
      document.documentElement.classList.remove('is-shop-marquee');
    }

    function onKey(event) {
      if (event.key !== 'Escape') return;
      origin = null;
      armed = false;
      setBand(null);
      setSelected(new Set());
      document.documentElement.classList.remove('is-shop-marquee');
    }

    panel.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      panel.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
      document.documentElement.classList.remove('is-shop-marquee');
    };
  }, []);

  const box = band && (band.width > 0 || band.height > 0) ? (
    <div
      className="shop-marquee"
      style={{
        left: `${band.left}px`,
        top: `${band.top}px`,
        width: `${band.width}px`,
        height: `${band.height}px`,
      }}
    />
  ) : null;

  return (
    <div ref={ref} className={['shop-list', className].filter(Boolean).join(' ')}>
      {typeof children === 'function' ? children(selected) : children}
      {box && typeof document !== 'undefined' ? createPortal(box, document.body) : null}
    </div>
  );
}
