import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { applyCardSelect, bandHits, selectionFromBand } from '../card-select.js';
import { addCatalogCards } from '../cart-add.js';
import { useCart } from '../cart.jsx';
import { cardReference } from '../chat-listing.js';
import { stageChatCards } from '../chat-dock-store.js';

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
  const { addItem } = useCart();
  const rootRef = useRef(null);
  const dragRef = useRef(null);
  const [selected, setSelected] = useState(() => new Set());
  const [anchor, setAnchor] = useState('');
  const [band, setBand] = useState(null);
  const [busy, setBusy] = useState('');
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

  const picked = useMemo(
    () => (cards || []).filter((card) => selected.has(String(card?.id || ''))),
    [cards, selected],
  );

  function commit(next, nextAnchor = anchor) {
    setSelected(next);
    if (nextAnchor) setAnchor(nextAnchor);
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    if (event.target.closest('a, button, input, select, textarea, label')) return;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      ctrl: event.ctrlKey || event.metaKey,
      base: event.ctrlKey || event.metaKey ? new Set(selectedRef.current) : new Set(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    const drag = dragRef.current;
    if (!drag) return;
    const box = { x0: drag.x, y0: drag.y, x1: event.clientX, y1: event.clientY };
    const wide = Math.abs(box.x1 - box.x0) >= 4 || Math.abs(box.y1 - box.y0) >= 4;
    setBand(wide ? box : null);
    if (!wide) return;
    const hits = bandHits(tileRects(rootRef.current), box);
    setSelected(selectionFromBand(drag.base, hits, { ctrl: drag.ctrl }));
  }

  function onPointerUp(event) {
    const drag = dragRef.current;
    dragRef.current = null;
    setBand(null);
    if (!drag) return;
    const moved = Math.abs(event.clientX - drag.x) >= 4 || Math.abs(event.clientY - drag.y) >= 4;
    if (!moved) {
      setSelected(new Set());
      setAnchor('');
    }
  }

  async function addToCart() {
    if (!picked.length || busy) return;
    setBusy('cart');
    try {
      await addCatalogCards(picked, addItem);
    } finally {
      setBusy('');
    }
  }

  function addToChat() {
    if (!picked.length || busy) return;
    stageChatCards(picked.map((card) => cardReference(card)));
  }

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
        {picked.length ? (
          <div className="card-select-bar" role="toolbar" aria-label="Selected cards">
            <strong>{picked.length} selected</strong>
            <button type="button" onClick={addToCart} disabled={Boolean(busy)}>
              {busy === 'cart' ? 'Adding…' : 'Add to cart'}
            </button>
            <button type="button" onClick={addToChat} disabled={Boolean(busy)}>Add to chat</button>
            <button type="button" onClick={() => { setSelected(new Set()); setAnchor(''); }}>Clear</button>
          </div>
        ) : null}
        <div
          ref={rootRef}
          className={className}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {children}
          {bandStyle ? <div className="card-select-band" style={bandStyle} /> : null}
        </div>
      </div>
    </CardSelectContext.Provider>
  );
}
