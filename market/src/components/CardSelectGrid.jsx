import { createContext, useContext, useId, useLayoutEffect, useMemo } from 'react';
import { useSelectBand } from '../select-band.jsx';

const CardSelectContext = createContext(null);

export function useCardSelect() {
  return useContext(CardSelectContext);
}

/**
 * Marks a card grid for multi-select. Gesture listeners live in SelectBandProvider
 * (Chrome) so they stay warm across navigations — this registers `cards` into the
 * page-wide catalog so a drag pile can span every rail on the page.
 */
export default function CardSelectGrid({
  cards = [],
  className = 'grid',
  contents = false,
  children,
}) {
  const band = useSelectBand();
  const gridKey = useId();
  const ids = useMemo(
    () => (cards || []).map((card) => String(card?.id || '')).filter(Boolean),
    [cards],
  );

  useLayoutEffect(() => {
    if (!band?.registerCards) return undefined;
    band.registerCards(gridKey, cards);
    return () => band.unregisterCards?.(gridKey);
  }, [band, gridKey, cards]);

  const api = useMemo(() => {
    if (!band) {
      return {
        selected: new Set(),
        click() {},
        cardsForDrag(card) { return [card]; },
      };
    }
    return {
      selected: band.selected,
      click(id, event) {
        band.click(id, event, ids);
      },
      cardsForDrag(card) {
        return band.cardsForDrag(card);
      },
      dragReference(held) {
        return band.dragReference?.(held) || null;
      },
    };
  }, [band, ids]);

  return (
    <CardSelectContext.Provider value={api}>
      <div className={contents ? 'card-select-host is-contents' : 'card-select-host'}>
        <div className={contents ? ['is-contents', className].filter(Boolean).join(' ') : className}>
          {children}
        </div>
      </div>
    </CardSelectContext.Provider>
  );
}
