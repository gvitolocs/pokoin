import { useState } from 'react';
import { formatPkn } from '../api.js';
import { goMarket, marketUrl } from '../punchouts.js';

const PREVIEW_COUNT = 48;

function assetMeta(item) {
  const flags = [
    item.reverse ? 'Reverse' : '',
    item.firstEdition ? '1st Ed.' : '',
    item.graded ? 'Graded' : '',
  ].filter(Boolean);
  return [item.setName, item.condition, item.language, ...flags].filter(Boolean).join(' · ');
}

function AssetTile({ item }) {
  const name = item.cardName || 'Card';
  const href = item.cardId ? marketUrl(`/marketplace/en/cards/${item.cardId}`) : '';
  const body = (
    <>
      <span className="ct1dr-art">
        {item.imageUrl ? <img src={item.imageUrl} alt="" loading="lazy" /> : <span className="tile-ph" aria-hidden="true" />}
        {item.quantity > 1 ? <span className="ct1dr-qty">×{item.quantity}</span> : null}
      </span>
      <span className="ct1dr-name">{name}</span>
      <span className="ct1dr-meta">{assetMeta(item)}</span>
      <span className="ct1dr-price">{item.pricePkn > 0 ? formatPkn(item.pricePkn) : '—'}</span>
    </>
  );
  if (!href) return <div className="ct1dr-tile">{body}</div>;
  return (
    <a
      className="ct1dr-tile"
      href={href}
      title={name}
      onClick={(event) => {
        if (!href.startsWith('http')) return;
        event.preventDefault();
        goMarket(href);
      }}
    >
      {body}
    </a>
  );
}

/**
 * CardTrader 1-Day Ready inventory on the dashboard. That stock sits in
 * CardTrader's warehouse and CardTrader sells it, so it is shown as assets,
 * never as Pokoin listings. Renders nothing for other sellers.
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
          <p className="ct1dr-totals">
            <strong>{Number(totals.cards || 0).toLocaleString('en-US')}</strong> cards
            {' · '}
            <strong>{formatPkn(totals.valuePkn || 0)}</strong>
          </p>
        ) : null}
      </header>
      <p className="ct1dr-lede">
        Stocked and sold by CardTrader 1-Day Ready, so these cards are assets here — not Pokoin listings.
      </p>
      {items.length ? (
        <div className="ct1dr-grid">
          {shown.map((item) => <AssetTile key={item.ctProductId} item={item} />)}
        </div>
      ) : (
        <p className="seller-panel-empty">No 1-Day Ready cards yet. Run Sync CardTrader in Profile.</p>
      )}
      {items.length > PREVIEW_COUNT ? (
        <button type="button" className="btn ghost ct1dr-more" onClick={() => setShowAll((all) => !all)}>
          {showAll ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      ) : null}
    </section>
  );
}
