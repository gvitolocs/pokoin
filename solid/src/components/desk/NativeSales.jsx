import { createMemo, For, Loading, onCleanup, Show } from 'solid-js';
import { fetchNativeSales, formatPkn } from '@market/api.js';
import { formatOrderMoney } from '@market/order-status.js';

function day(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '';
}

/**
 * "Sold on Pokoin" (market/src/components/NativeSales.jsx): paid native
 * orders for this printing. An async memo under its own Loading boundary, so
 * the desk never waits on it; renders nothing until there is a sale.
 */
export default function NativeSales(props) {
  const rows = createMemo(() => {
    const id = props.cardId;
    if (!id) return [];
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    return fetchNativeSales(id, { signal: controller.signal })
      .then((data) => (Array.isArray(data?.sales) ? data.sales : []))
      .catch(() => []);
  });
  return (
    <Loading fallback={null}>
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
    </Loading>
  );
}
