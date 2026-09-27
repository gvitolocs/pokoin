import { createContext, useContext, useMemo } from 'react';
import { useSelectBand } from '../select-band.jsx';

const CardSelectContext = createContext(null);

export function useCardSelect() {
  return useContext(CardSelectContext);
}

/**
 * Marks a card grid for multi-select. Gesture listeners live in SelectBandProvider
 * (Chrome) so they stay warm across navigations — this only supplies selection
 * context for the tiles in `cards`.
 */
export default function CardSelectGrid({
  cards = [],
  className = 'grid',
  contents = false,
  children,
}) {
  const band = useSelectBand();
  const ids = useMemo(
    () => (cards || []).map((card) => String(card?.id || '')).filter(Boolean),
    [cards],
  );

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
        return band.cardsForDrag(card, cards);
      },
    };
  }, [band, cards, ids]);

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
