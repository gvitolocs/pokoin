import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { marqueeBlocked, marqueeRect, rectsIntersect } from '../shop-marquee.js';

const DRAG_THRESHOLD = 5;

/**
 * Shop rows. Press the row body or the space under the list and drag,
 * the same way a desktop selects files. Links and the card scan keep their
 * own click and drag.
 */
export default function ShopList({ className = '', children }) {
  const ref = useRef(null);
  const [band, setBand] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useLayoutEffect(() => {
    const list = ref.current;
    if (!list || !band) return;
    for (const row of list.querySelectorAll('.shop-row')) {
      if (row.draggable) {
        row.dataset.wasDraggable = '1';
        row.draggable = false;
      }
    }
  }, [band, selected]);

  useEffect(() => {
    const list = ref.current;
    const panel = list?.closest('.shop-panel') || list;
    if (!panel) return undefined;

    let origin = null;
    let armed = false;
    let base = new Set();
    let anchor = '';

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

    function restoreDrag() {
      for (const row of rowBoxes()) {
        if (row.dataset.wasDraggable) {
          row.draggable = true;
          delete row.dataset.wasDraggable;
        }
      }
    }

    function selectedRow(target) {
      const row = target?.closest?.('.shop-row[data-listing-id]');
      const id = row?.dataset.listingId;
      if (!id || !selectedRef.current.has(id)) return null;
      return row;
    }

    function onDown(event) {
      if (event.button !== 0) return;
      if (!panel.contains(event.target)) return;
      if (marqueeBlocked(event.target)) return;
      if (selectedRow(event.target)) return;
      const row = event.target.closest?.('.shop-row');
      if (row?.draggable) {
        row.dataset.wasDraggable = '1';
        row.draggable = false;
      }
      origin = {
        x: event.clientX,
        y: event.clientY,
        additive: event.ctrlKey || event.metaKey,
        shift: event.shiftKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        target: event.target,
      };
      armed = false;
      base = origin.additive ? new Set(selectedRef.current) : new Set();
      try { panel.setPointerCapture(event.pointerId); } catch { /* mouse fallback */ }
    }

    function onMouseDown(event) {
      if (event.button !== 0) return;
      if (!panel.contains(event.target)) return;
      if (marqueeBlocked(event.target)) return;
      if (selectedRow(event.target)) return;
      // A draggable row would steal this gesture for an HTML5 card drag.
      event.preventDefault();
    }

    function onDragStart(event) {
      if (!origin || marqueeBlocked(origin.target)) return;
      event.preventDefault();
    }

    function onMove(event) {
      if (!origin) return;
      const rect = marqueeRect(origin.x, origin.y, event.clientX, event.clientY);
      if (!armed && Math.hypot(rect.width, rect.height) < DRAG_THRESHOLD) return;
      if (!armed) {
        armed = true;
        try { panel.setPointerCapture(event.pointerId); } catch { /* already released */ }
      }
      document.documentElement.classList.add('is-shop-marquee');
      setBand(rect);
      paint(rect);
    }

    function onUp(event) {
      if (armed) {
        const stopClick = (clickEvent) => {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
          window.removeEventListener('click', stopClick, true);
        };
        window.addEventListener('click', stopClick, true);
      } else if (origin?.target?.closest?.('a')) {
        origin.target.closest('a').dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          shiftKey: origin.shift,
          ctrlKey: origin.ctrl,
          metaKey: origin.meta,
          clientX: origin.x,
          clientY: origin.y,
        }));
      } else if (origin?.target?.closest?.('.shop-row')) {
        // mousedown preventDefault cancels the real click, so replay it.
        origin.target.closest('.shop-row').dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          shiftKey: origin.shift,
          ctrlKey: origin.ctrl,
          metaKey: origin.meta,
          clientX: origin.x,
          clientY: origin.y,
        }));
      } else if (origin && !origin.additive) {
        setSelected(new Set());
      }
      origin = null;
      armed = false;
      setBand(null);
      restoreDrag();
      document.documentElement.classList.remove('is-shop-marquee');
    }

    function onKey(event) {
      if (event.key !== 'Escape') return;
      origin = null;
      armed = false;
      anchor = '';
      setBand(null);
      setSelected(new Set());
      restoreDrag();
      document.documentElement.classList.remove('is-shop-marquee');
    }

    function onClick(event) {
      if (!(event.shiftKey || event.ctrlKey || event.metaKey)) return;
      const row = event.target?.closest?.('.shop-row[data-listing-id]');
      if (!row || !list.contains(row)) return;
      if (event.target?.closest?.('a, button, input, select, textarea, .ct-qty, .art-frame')) return;
      event.preventDefault();
      const id = row.dataset.listingId;
      const ids = rowBoxes().map((item) => item.dataset.listingId).filter(Boolean);
      setSelected((prev) => {
        const next = new Set(prev);
        if (event.shiftKey && anchor) {
          const from = ids.indexOf(anchor);
          const to = ids.indexOf(id);
          if (from >= 0 && to >= 0) {
            const [lo, hi] = from < to ? [from, to] : [to, from];
            const range = new Set(event.ctrlKey || event.metaKey ? prev : []);
            for (let i = lo; i <= hi; i += 1) range.add(ids[i]);
            return range;
          }
        }
        if ((event.ctrlKey || event.metaKey) && next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      anchor = id;
    }

    panel.addEventListener('pointerdown', onDown);
    panel.addEventListener('mousedown', onMouseDown);
    panel.addEventListener('dragstart', onDragStart, true);
    panel.addEventListener('click', onClick);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      panel.removeEventListener('pointerdown', onDown);
      panel.removeEventListener('mousedown', onMouseDown);
      panel.removeEventListener('dragstart', onDragStart, true);
      panel.removeEventListener('click', onClick);
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
