import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { applyCardSelect, bandHits, cardsForDragFromCatalog, selectionFromBand } from './card-select.js';
import {
  clearShopSelectionOnPointer,
  marqueeRectForScroll,
  marqueeStartAllowed,
  mixedDeskDragReference,
  rectsIntersect,
  selectBandAllowed,
} from './shop-marquee.js';

const SelectBandContext = createContext(null);

const DRAG_THRESHOLD = 5;

function cardRects() {
  const scope = document.querySelector('main');
  if (!scope) return [];
  return [...scope.querySelectorAll('[data-card-id]')].flatMap((node) => {
    const id = node.getAttribute('data-card-id');
    if (!id) return [];
    const rect = node.getBoundingClientRect();
    return [{
      id,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    }];
  });
}

function listingRows() {
  return [...document.querySelectorAll('main .shop-row[data-listing-id]')];
}

function listingRects() {
  return listingRows().map((row) => {
    const box = row.getBoundingClientRect();
    return {
      id: row.dataset.listingId,
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
    };
  }).filter((row) => row.id);
}

/**
 * App-lifetime rubber-band host. Mounted once under Chrome so navigation never
 * tears down pointer listeners (no per-page "warmup").
 */
export function SelectBandProvider({ children }) {
  const location = useLocation();
  const [cardSelected, setCardSelected] = useState(() => new Set());
  const [listingSelected, setListingSelected] = useState(() => new Set());
  const [band, setBand] = useState(null);
  const [cardAnchor, setCardAnchor] = useState('');
  const cardSelectedRef = useRef(cardSelected);
  const listingSelectedRef = useRef(listingSelected);
  const cardAnchorRef = useRef(cardAnchor);
  const listingAnchorRef = useRef('');
  cardSelectedRef.current = cardSelected;
  listingSelectedRef.current = listingSelected;
  cardAnchorRef.current = cardAnchor;
  const originRef = useRef(null);
  const armedRef = useRef(false);
  const pointerRef = useRef({ x: 0, y: 0 });
  const gridCardsRef = useRef(new Map());
  const catalogRef = useRef(new Map());
  const shopRef = useRef({ offers: [], deskCard: null });

  function rebuildCatalog() {
    const next = new Map();
    for (const list of gridCardsRef.current.values()) {
      for (const card of list || []) {
        const id = String(card?.id || card?.cardId || '');
        if (id) next.set(id, card);
      }
    }
    const desk = shopRef.current.deskCard;
    if (desk?.id) next.set(String(desk.id), desk);
    catalogRef.current = next;
  }

  // Drop the active selection when the route changes; keep listeners.
  useEffect(() => {
    setCardSelected(new Set());
    setListingSelected(new Set());
    setCardAnchor('');
    listingAnchorRef.current = '';
    setBand(null);
    originRef.current = null;
    armedRef.current = false;
    gridCardsRef.current.clear();
    catalogRef.current = new Map();
    shopRef.current = { offers: [], deskCard: null };
    document.documentElement.classList.remove('is-card-banding', 'is-shop-marquee');
  }, [location.pathname, location.search]);

  useLayoutEffect(() => {
    function restoreListingDrag() {
      for (const row of listingRows()) {
        if (row.dataset.wasDraggable) {
          row.draggable = true;
          delete row.dataset.wasDraggable;
        }
      }
    }

    function paint(rect) {
      const origin = originRef.current;
      const cardHits = bandHits(cardRects(), {
        x0: rect.left,
        y0: rect.top,
        x1: rect.right,
        y1: rect.bottom,
      });
      setCardSelected(selectionFromBand(
        origin?.additive ? origin.cardBase : new Set(),
        cardHits,
        { ctrl: Boolean(origin?.additive) },
      ));

      const nextListings = new Set(origin?.additive ? origin.listingBase : []);
      for (const row of listingRects()) {
        const hit = rectsIntersect(rect, row);
        if (hit) nextListings.add(row.id);
        else if (!origin?.additive) nextListings.delete(row.id);
      }
      setListingSelected(nextListings);
    }

    function onOutsideDown(event) {
      if (event.button !== 0) return;
      if (!selectBandAllowed(event)) return;
      if (!clearShopSelectionOnPointer(
        event.target,
        document.querySelector('main .shop-list'),
        listingSelectedRef.current,
        event,
      )) {
        return;
      }
      if (listingSelectedRef.current.size) {
        setListingSelected(new Set());
        listingAnchorRef.current = '';
      }
    }

    function onDown(event) {
      if (event.button !== 0) return;
      if (!selectBandAllowed(event)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!marqueeStartAllowed(target)) return;
      const listingRow = target.closest?.('.shop-row[data-listing-id]');
      const listingId = listingRow?.dataset?.listingId || '';
      if (listingId && listingSelectedRef.current.has(listingId)) return;

      originRef.current = {
        x: event.clientX,
        y: event.clientY,
        scrollX: window.scrollX || 0,
        scrollY: window.scrollY || 0,
        additive: event.ctrlKey || event.metaKey,
        cardBase: event.ctrlKey || event.metaKey ? new Set(cardSelectedRef.current) : new Set(),
        listingBase: event.ctrlKey || event.metaKey ? new Set(listingSelectedRef.current) : new Set(),
      };
      pointerRef.current = { x: event.clientX, y: event.clientY };
      armedRef.current = false;
    }

    function onMouseDown(event) {
      if (event.button !== 0) return;
      if (!selectBandAllowed(event)) return;
      if (!marqueeStartAllowed(event.target)) return;
      // Keep empty-background bands from turning into text selection.
      event.preventDefault();
    }

    function bandFromPointer(clientX, clientY) {
      const origin = originRef.current;
      if (!origin) return null;
      return marqueeRectForScroll(
        origin,
        clientX,
        clientY,
        window.scrollX || 0,
        window.scrollY || 0,
      );
    }

    function onMove(event) {
      const origin = originRef.current;
      if (!origin) return;
      pointerRef.current = { x: event.clientX, y: event.clientY };
      const rect = bandFromPointer(event.clientX, event.clientY);
      if (!rect) return;
      if (!armedRef.current && Math.hypot(rect.width, rect.height) < DRAG_THRESHOLD) return;
      if (!armedRef.current) {
        armedRef.current = true;
        for (const row of listingRows()) {
          if (row.draggable) {
            row.dataset.wasDraggable = '1';
            row.draggable = false;
          }
        }
      }
      document.documentElement.classList.add('is-card-banding', 'is-shop-marquee');
      setBand(rect);
      paint(rect);
    }

    /** Page/window scroll while the button is held — recompute the band so it tracks content. */
    function onScroll() {
      if (!originRef.current || !armedRef.current) return;
      const { x, y } = pointerRef.current;
      const rect = bandFromPointer(x, y);
      if (!rect) return;
      setBand(rect);
      paint(rect);
    }

    function onUp() {
      const armed = armedRef.current;
      if (armed) {
        const stopClick = (clickEvent) => {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
          window.removeEventListener('click', stopClick, true);
        };
        window.addEventListener('click', stopClick, true);
      } else if (originRef.current && !originRef.current.additive) {
        setCardSelected(new Set());
        setListingSelected(new Set());
        setCardAnchor('');
        listingAnchorRef.current = '';
      }
      originRef.current = null;
      armedRef.current = false;
      setBand(null);
      restoreListingDrag();
      document.documentElement.classList.remove('is-card-banding', 'is-shop-marquee');
    }

    function onKey(event) {
      if (event.key !== 'Escape') return;
      originRef.current = null;
      armedRef.current = false;
      setBand(null);
      setCardSelected(new Set());
      setListingSelected(new Set());
      setCardAnchor('');
      listingAnchorRef.current = '';
      restoreListingDrag();
      document.documentElement.classList.remove('is-card-banding', 'is-shop-marquee');
    }

    function onListingClick(event) {
      if (!selectBandAllowed(event)) return;
      if (!(event.shiftKey || event.ctrlKey || event.metaKey)) return;
      const row = event.target?.closest?.('.shop-row[data-listing-id]');
      if (!row) return;
      if (event.target?.closest?.('a, button, input, select, textarea, .ct-qty, .art-frame')) return;
      const list = row.closest('.shop-list');
      if (!list?.contains(row)) return;
      event.preventDefault();
      const id = row.dataset.listingId;
      const ids = [...list.querySelectorAll('.shop-row[data-listing-id]')]
        .map((item) => item.dataset.listingId)
        .filter(Boolean);
      setListingSelected((prev) => {
        if (event.shiftKey && listingAnchorRef.current) {
          const from = ids.indexOf(listingAnchorRef.current);
          const to = ids.indexOf(id);
          if (from >= 0 && to >= 0) {
            const [lo, hi] = from < to ? [from, to] : [to, from];
            const range = new Set(event.ctrlKey || event.metaKey ? prev : []);
            for (let i = lo; i <= hi; i += 1) range.add(ids[i]);
            return range;
          }
        }
        const next = new Set(prev);
        if ((event.ctrlKey || event.metaKey) && next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      listingAnchorRef.current = id;
    }

    document.addEventListener('pointerdown', onDown);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('pointerdown', onOutsideDown, true);
    document.addEventListener('click', onListingClick);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('pointerdown', onOutsideDown, true);
      document.removeEventListener('click', onListingClick);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey);
      restoreListingDrag();
      document.documentElement.classList.remove('is-card-banding', 'is-shop-marquee');
    };
  }, []);

  const api = useMemo(() => ({
    selected: cardSelected,
    listingSelected,
    registerCards(gridKey, cards) {
      const key = String(gridKey || '');
      if (!key) return;
      gridCardsRef.current.set(key, cards || []);
      rebuildCatalog();
    },
    unregisterCards(gridKey) {
      const key = String(gridKey || '');
      if (!key) return;
      gridCardsRef.current.delete(key);
      rebuildCatalog();
    },
    registerShop({ offers = [], deskCard = null } = {}) {
      shopRef.current = { offers: offers || [], deskCard: deskCard || null };
      rebuildCatalog();
    },
    unregisterShop() {
      shopRef.current = { offers: [], deskCard: null };
      rebuildCatalog();
    },
    click(id, event, ids = []) {
      if (!selectBandAllowed(event)) return;
      const next = applyCardSelect(
        { selected: cardSelectedRef.current, anchor: cardAnchorRef.current },
        ids,
        id,
        { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey },
      );
      setCardSelected(next.selected);
      if (next.anchor) setCardAnchor(next.anchor);
    },
    cardsForDrag(card) {
      // Prefer DOM order so a pile spanning Recently viewed + New cards stays
      // left-to-right / top-to-bottom, then fill any selected id still in catalog.
      const selected = cardSelectedRef.current;
      const ordered = new Map();
      if (typeof document !== 'undefined') {
        for (const node of document.querySelectorAll('main [data-card-id]')) {
          const cid = node.getAttribute('data-card-id');
          if (!cid || !selected.has(cid) || ordered.has(cid)) continue;
          const row = catalogRef.current.get(cid);
          if (row) ordered.set(cid, row);
        }
      }
      for (const cid of selected) {
        if (ordered.has(cid)) continue;
        const row = catalogRef.current.get(cid);
        if (row) ordered.set(cid, row);
      }
      return cardsForDragFromCatalog(card, selected, ordered.size ? ordered : catalogRef.current);
    },
    /** Desk drag: listings + tiles together when both are multi-selected. */
    dragReference({ heldCard = null, heldOffer = null } = {}) {
      const shop = shopRef.current;
      const cards = cardSelectedRef.current;
      const listings = listingSelectedRef.current;
      const total = cards.size + listings.size;
      if (total < 2) return null;
      return mixedDeskDragReference({
        heldOffer,
        heldCard,
        offers: shop.offers,
        catalog: catalogRef.current,
        cardSelected: cards,
        listingSelected: listings,
        deskCard: shop.deskCard,
      });
    },
  }), [cardSelected, listingSelected]);

  const box = band && (band.width > 0 || band.height > 0) ? (
    <div
      className="card-select-band shop-marquee"
      style={{
        left: `${band.left}px`,
        top: `${band.top}px`,
        width: `${band.width}px`,
        height: `${band.height}px`,
      }}
    />
  ) : null;

  return (
    <SelectBandContext.Provider value={api}>
      {children}
      {box && typeof document !== 'undefined' ? createPortal(box, document.body) : null}
    </SelectBandContext.Provider>
  );
}

export function useSelectBand() {
  return useContext(SelectBandContext);
}
