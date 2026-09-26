import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { applyCardSelect, bandHits, selectionFromBand } from '../card-select.js';

const CardSelectContext = createContext(null);

export function useCardSelect() {
  return useContext(CardSelectContext);
}

function tileRects(root) {
  if (!root) return [];
  return [...root.querySelectorAll('[data-card-id]')].map((node) => {
    const rect = node.getBoundingClientRect();
    return {
      id: node.getAttribute('data-card-id'),
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    };
  });
}

export default function CardSelectGrid({ cards = [], className = 'grid', children }) {
  const rootRef = useRef(null);
  const dragRef = useRef(null);
  const [selected, setSelected] = useState(() => new Set());
  const [anchor, setAnchor] = useState('');
  const [band, setBand] = useState(null);
  const ids = useMemo(
    () => (cards || []).map((card) => String(card?.id || '')).filter(Boolean),
    [cards],
  );
  const idKey = ids.join('|');
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    const allowed = new Set(ids);
    setSelected((current) => {
      const next = new Set([...current].filter((id) => allowed.has(id)));
      if (next.size === current.size && [...next].every((id) => current.has(id))) return current;
      return next;
    });
  }, [idKey, ids]);

  useEffect(() => {
    if (!selected.size) return undefined;
    function onKey(event) {
      if (event.key === 'Escape') {
        setSelected(new Set());
        setAnchor('');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected.size]);

  function commit(next, nextAnchor = anchor) {
    setSelected(next);
    if (nextAnchor) setAnchor(nextAnchor);
  }

  useEffect(() => {
    function ignored(target) {
      return target instanceof Element && target.closest(
        'a, button, input, select, textarea, label, header, footer, nav, .topbar, .seller-history, .suggest, .cart-drop',
      );
    }
    function onDown(event) {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (ignored(target) || target.closest('[data-card-id]')) return;
      if (!target.closest('main')) return;
      dragRef.current = {
        x: event.clientX,
        y: event.clientY,
        ctrl: event.ctrlKey || event.metaKey,
        base: event.ctrlKey || event.metaKey ? new Set(selectedRef.current) : new Set(),
      };
      document.documentElement.classList.add('is-card-banding');
    }
    function onMove(event) {
      const drag = dragRef.current;
      if (!drag) return;
      const box = { x0: drag.x, y0: drag.y, x1: event.clientX, y1: event.clientY };
      const wide = Math.abs(box.x1 - box.x0) >= 4 || Math.abs(box.y1 - box.y0) >= 4;
      setBand(wide ? box : null);
      if (!wide) return;
      const hits = bandHits(tileRects(rootRef.current), box);
      setSelected(selectionFromBand(drag.base, hits, { ctrl: drag.ctrl }));
    }
    function onUp(event) {
      const drag = dragRef.current;
      dragRef.current = null;
      setBand(null);
      document.documentElement.classList.remove('is-card-banding');
      if (!drag) return;
      const moved = Math.abs(event.clientX - drag.x) >= 4 || Math.abs(event.clientY - drag.y) >= 4;
      if (!moved) {
        setSelected(new Set());
        setAnchor('');
      }
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.documentElement.classList.remove('is-card-banding');
    };
  }, []);

  const api = {
    selected,
    click(id, event) {
      const next = applyCardSelect(
        { selected: selectedRef.current, anchor },
        ids,
        id,
        { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey },
      );
      commit(next.selected, next.anchor);
    },
    cardsForDrag(card) {
      const id = String(card?.id || '');
      if (!id || !selectedRef.current.has(id) || selectedRef.current.size < 2) return [card];
      return (cards || []).filter((row) => selectedRef.current.has(String(row?.id || '')));
    },
  };

  const bandStyle = band ? {
    left: Math.min(band.x0, band.x1),
    top: Math.min(band.y0, band.y1),
    width: Math.abs(band.x1 - band.x0),
    height: Math.abs(band.y1 - band.y0),
  } : null;

  return (
    <CardSelectContext.Provider value={api}>
      <div className="card-select-host">
        <div
          ref={rootRef}
          className={className}
        >
          {children}
          {bandStyle ? <div className="card-select-band" style={bandStyle} /> : null}
        </div>
      </div>
    </CardSelectContext.Provider>
  );
}
