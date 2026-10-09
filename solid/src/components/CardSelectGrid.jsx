import { createContext, createEffect, createMemo, createUniqueId, untrack, useContext } from 'solid-js';
import { cardSelected, clickCard, dragPayload, registerGridCards, unregisterGridCards } from '../lib/select-band.js';

const CardSelectContext = createContext(null);

/** The grid a tile sits in, or null outside one (plain single-card links). */
export function useCardSelect() {
  return useContext(CardSelectContext);
}

/**
 * Marks a card grid for multi-select (market/src/components/CardSelectGrid.jsx).
 * The gestures live in lib/select-band*.js (installed once by Chrome); this
 * registers `cards` into the page-wide catalog so a drag pile can span every
 * rail on the page, and ranges Shift-clicks over this grid's ids. Same
 * wrapper markup as React so grid and rail CSS match.
 */
export default function CardSelectGrid(props) {
  const gridKey = createUniqueId();
  const ids = createMemo(() => (props.cards || []).map((card) => String(card?.id || '')).filter(Boolean));

  // Compute copies the list (tracking it); the catalog keeps the rows as
  // given — store-backed tiles stay live — read outside tracking.
  createEffect(
    () => [...(props.cards || [])],
    (cards) => {
      untrack(() => registerGridCards(gridKey, cards));
      return () => unregisterGridCards(gridKey);
    },
  );

  const api = {
    isSelected: (id) => cardSelected().has(String(id)),
    click(id, event) {
      clickCard(id, event, ids());
    },
    dragPayload,
  };

  return (
    <CardSelectContext value={api}>
      <div class={props.contents ? 'card-select-host is-contents' : 'card-select-host'}>
        <div class={props.contents ? ['is-contents', props.class ?? 'grid'] : (props.class ?? 'grid')}>
          {props.children}
        </div>
      </div>
    </CardSelectContext>
  );
}
