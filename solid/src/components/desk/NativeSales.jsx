import { createSignal, For, onCleanup, Show } from 'solid-js';
import { fetchNativeSales, formatPkn } from '@market/api.js';
import { peekNativeSales, saveNativeSales } from '@market/native-sales-cache.js';
import { formatOrderMoney } from '@market/order-status.js';

function day(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '';
}

/**
 * "Sold on Pokoin": paid native orders for this printing. What a previous visit
 * left behind paints at once and is still re-read below, so the panel is either
 * there in the first frame or not on this desk at all — it never appears under a
 * visitor who has started reading the card. A failed re-read leaves the drawn
 * rows standing.
 */
export default function NativeSales(props) {
  const id = String(props.cardId || '');
  const [sales, setSales] = createSignal(peekNativeSales(id)?.sales ?? null);
  if (id) {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    fetchNativeSales(id, { signal: controller.signal }).then((data) => {
      const rows = Array.isArray(data?.sales) ? data.sales : null;
      if (!rows) return;
      saveNativeSales(id, rows);
      setSales((prev) => (prev && JSON.stringify(prev) === JSON.stringify(rows) ? prev : rows));
    }).catch(() => {
      /* the rows this desk already showed are better than none */
    });
  }
  const rows = () => sales() || [];
  return (
    <Show when={rows().length}>
      <section class="panel native-sales" aria-label="Sold on Pokoin">
        <div class="panel-head">
          <h2>Sold on Pokoin</h2>
          <span class="muted">{rows().length} recent</span>
        </div>
        <ul class="native-sales-list">
          <For each={rows().slice(0, 8)}>
            {(row) => (
              <li>
                <span class="native-sales-day">{day(row.soldAt)}</span>
                <span class="native-sales-traits">
                  {[row.condition, row.language].filter(Boolean).join(' ')}
                  {row.quantity > 1 ? ` ×${row.quantity}` : ''}
                </span>
                <strong class="native-sales-price">
                  {row.currency === 'EUR' && row.unitPriceEURCents
                    ? formatOrderMoney(row.unitPriceEURCents, 'EUR')
                    : formatPkn(row.unitPricePkn)}
                </strong>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}
