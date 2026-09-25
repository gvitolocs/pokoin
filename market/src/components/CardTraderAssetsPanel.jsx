import { useState } from 'react';
import { formatPkn } from '../api.js';
import { marketUrl } from '../punchouts.js';
import MiniCardTile from './MiniCardTile.jsx';

// Same 12-by-6 miniature sheet as Your listings.
const PREVIEW_COUNT = 72;

function assetTitle(item) {
  const flags = [
    item.reverse ? 'Reverse' : '',
    item.firstEdition ? '1st Ed.' : '',
    item.graded ? 'Graded' : '',
  ].filter(Boolean);
  const details = [
    item.cardName || 'Card',
    item.setName,
    item.condition,
    item.language,
    ...flags,
    item.pricePkn > 0 ? formatPkn(item.pricePkn) : '',
  ].filter(Boolean).join(' · ');
  return item.quantity > 1 ? `${details} · Qty ${item.quantity}` : details;
}

/**
 * CardTrader 1-Day Ready inventory on the dashboard, beside Your listings.
 * That stock sits in CardTrader's warehouse and CardTrader sells it, so it is
 * shown as assets, never as Pokoin listings. Renders nothing for other sellers.
 */
export default function CardTraderAssetsPanel({ assets }) {
  const [showAll, setShowAll] = useState(false);
  if (!assets?.oneDayReady) return null;
  const items = Array.isArray(assets.items) ? assets.items : [];
  const totals = assets.totals || {};
  const shown = showAll ? items : items.slice(0, PREVIEW_COUNT);
  return (
    <section className="seller-panel ct1dr-panel" aria-labelledby="ct1dr-title" data-testid="cardtrader-1dr-assets">
      <header className="seller-panel-head">
        <h2 id="ct1dr-title">CardTrader 1-DR</h2>
        {items.length ? (
          <span className="ct1dr-totals" title="Stocked and sold by CardTrader 1-Day Ready — not listed on Pokoin">
            {Number(totals.cards || 0).toLocaleString('en-US')} cards · {formatPkn(totals.valuePkn || 0) || 'no homepage minimum'}
          </span>
        ) : null}
      </header>
      {items.length ? (
        <div className="seller-listing-list" data-testid="cardtrader-1dr-grid">
          {shown.map((item) => (
            <MiniCardTile
              key={item.ctProductId}
              imageUrl={item.imageUrl}
              name={item.cardName || 'Card'}
              title={assetTitle(item)}
              cardId={item.cardId || ''}
              pricePkn={item.pricePkn}
              href={item.cardId ? marketUrl(`/marketplace/en/cards/${item.cardId}`) : ''}
              badge={item.quantity > 1 ? `×${item.quantity}` : ''}
            />
          ))}
        </div>
      ) : (
        <p className="seller-panel-empty">No 1-Day Ready cards yet. Run Sync CardTrader in Profile.</p>
      )}
      <p className="ct1dr-lede">Stocked and sold by CardTrader 1-Day Ready — not listed on Pokoin.</p>
      {items.length > PREVIEW_COUNT ? (
        <button type="button" className="seller-panel-link ct1dr-more" onClick={() => setShowAll((all) => !all)}>
          {showAll ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      ) : null}
    </section>
  );
}
