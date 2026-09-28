import { useEffect, useState } from 'react';
import { fetchNativeSales, formatPkn } from '../api.js';
import { formatOrderMoney } from '../order-status.js';

function day(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '';
}

/**
 * "Sold on Pokoin": paid native Pokoin orders for this printing (site PKN and
 * EUR checkout). The sold graph above stays CardTrader comps; this is only what
 * really sold through Pokoin. Renders nothing until there is a sale.
 */
export default function NativeSales({ cardId }) {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    setRows([]);
    if (!cardId) return undefined;
    const controller = new AbortController();
    fetchNativeSales(cardId, { signal: controller.signal })
      .then((data) => setRows(Array.isArray(data?.sales) ? data.sales : []))
      .catch(() => {});
    return () => controller.abort();
  }, [cardId]);

  if (!rows.length) return null;
  return (
    <section className="panel native-sales" aria-label="Sold on Pokoin">
      <div className="panel-head">
        <h2>Sold on Pokoin</h2>
        <span className="muted">{rows.length} recent</span>
      </div>
      <ul className="native-sales-list">
        {rows.slice(0, 8).map((row, index) => (
          <li key={`${row.soldAt}-${index}`}>
            <span className="native-sales-day">{day(row.soldAt)}</span>
            <span className="native-sales-traits">
              {[row.condition, row.language].filter(Boolean).join(' ')}
              {row.quantity > 1 ? ` ×${row.quantity}` : ''}
            </span>
            <strong className="native-sales-price">
              {row.currency === 'EUR' && row.unitPriceEURCents
                ? formatOrderMoney(row.unitPriceEURCents, 'EUR')
                : formatPkn(row.unitPricePkn)}
            </strong>
          </li>
        ))}
      </ul>
    </section>
  );
}
