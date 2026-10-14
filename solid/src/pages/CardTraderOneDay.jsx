import { createEffect, createSignal, For, Show } from 'solid-js';
import { fetchCardTraderAssets, fetchCardTraderZero } from '@market/api.js';
import { inventoryListingHref } from '@market/inventory-listings.js';
import { formatOrderMoney } from '@market/order-status.js';
import '@market/seller-home.css';
import '@market/one-day.css';
import { Alert, DeskPanel, EmptyDesk, Metric, MetricGrid, PageHead } from '../components/Desk.jsx';
import MiniCardTile from '../components/MiniCardTile.jsx';
import SignedIn from '../components/SignedIn.jsx';
import StockNav from '../components/StockNav.jsx';
import { getBearer, signedIn } from '../stores/auth.js';

function day(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    : '';
}

function facets(item) {
  return [
    item.condition,
    item.language,
    item.reverse ? 'Reverse' : '',
    item.firstEdition ? '1st ed.' : '',
    item.signed ? 'Signed' : '',
    item.altered ? 'Altered' : '',
    item.graded ? 'Graded' : '',
  ].filter(Boolean).join(' ');
}

function assetLabel(item) {
  return [
    item.cardName || 'Card',
    item.setName,
    item.collectorNumber ? `#${item.collectorNumber}` : '',
    item.condition,
    item.language,
    item.quantity > 1 ? `Qty ${item.quantity}` : '',
  ].filter(Boolean).join(' · ');
}

function SaleLine(props) {
  const item = () => props.item;
  const where = () => [item().expansion, item().collectorNumber ? `#${item().collectorNumber}` : ''].filter(Boolean).join(' · ');
  return (
    <div class="thread">
      <span class="thread-main">
        <strong class="thread-title">
          <Show when={item().cardId} fallback={item().name}><a href={inventoryListingHref(item())}>{item().name}</a></Show>
          <Show when={item().quantity > 1}><span class="zero-qty"> ×{item().quantity}</span></Show>
          {' '}
          <span class="pill order-pill is-ct">CardTrader 1-DR</span>
        </strong>
        <span class="thread-meta">
          {[
            where(),
            facets(item()),
            item().lineCents != null ? formatOrderMoney(item().lineCents, item().currency) : '',
            item().orderCode ? `CT ${item().orderCode}` : '',
            day(item().soldAt),
          ].filter(Boolean).join(' · ')}
        </span>
      </span>
    </div>
  );
}

function OneDayDesk() {
  const [sales, setSales] = createSignal(null);
  const [assets, setAssets] = createSignal(null);
  const [error, setError] = createSignal('');
  const [notConnected, setNotConnected] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [showStock, setShowStock] = createSignal(false);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const token = await getBearer();
      const [saleResult, assetResult] = await Promise.all([
        fetchCardTraderZero(token),
        fetchCardTraderAssets(token).catch(() => null),
      ]);
      setNotConnected(false);
      setSales(() => saleResult);
      setAssets(() => assetResult);
    } catch (err) {
      if (err.body?.code === 'cardtrader_not_connected') setNotConnected(true);
      else setError(err.message || 'CardTrader 1-DR failed.');
    } finally {
      setLoading(false);
    }
  }

  createEffect(signedIn, (on) => {
    if (on) load();
  });

  const pendingItems = () => sales()?.pending?.items || [];
  const heldItems = () => (sales()?.weekly || []).flatMap((order) => order.items || []);
  const oneDayReady = () => sales()?.oneDayReady === true || assets()?.oneDayReady === true;
  const warehouseCards = () => Math.max(0, Number(assets()?.totals?.cards) || 0);
  const stockItems = () => (Array.isArray(assets()?.items) ? assets().items : []);

  return (
    <div class="page desk">
      <PageHead
        kicker="Seller"
        title="CardTrader 1-DR"
        lede="CardTrader warehouses this stock and sells it. These sales are not a Zero shipment you pick and send. Each one also lands in Sold history with the CardTrader 1-DR tag."
      >
        <button class="btn ghost" type="button" onClick={load} disabled={loading() || notConnected()}>
          {loading() ? 'Refreshing…' : 'Refresh'}
        </button>
      </PageHead>
      <StockNav />
      <Alert>{error()}</Alert>

      <Show when={notConnected()}>
        <EmptyDesk title="Connect CardTrader first" lede="1-Day Ready sales are read from your CardTrader seller orders. Paste your CardTrader API token in Settings.">
          <a class="btn" href="/mypokoin/settings">Settings</a>
        </EmptyDesk>
      </Show>

      <Show when={sales() && !oneDayReady() && !notConnected()}>
        <EmptyDesk title="This account is not 1-Day Ready" lede="CardTrader Zero shipments stay on their own tab. A 1-Day Ready token puts warehouse sales here.">
          <a class="btn" href="/mypokoin/zero">CardTrader Zero</a>
        </EmptyDesk>
      </Show>

      <Show when={oneDayReady() && sales()}>
        <MetricGrid>
          <button
            type="button"
            class={['metric', 'dr-stock-open', { 'is-open': showStock() }]}
            onClick={() => setShowStock((open) => !open)}
            aria-expanded={String(showStock())}
          >
            <strong class="metric-value">{warehouseCards()}</strong>
            <span class="metric-label">Cards at CardTrader</span>
            <span class="metric-hint">{showStock() ? 'Hide cards' : 'View all cards'}</span>
          </button>
          <Metric
            value={sales().totals?.pending?.units || 0}
            label="Waiting at CardTrader"
            hint={`${sales().pending?.orderCount || 0} 1-DR sale${sales().pending?.orderCount === 1 ? '' : 's'}`}
          />
          <Metric
            value={sales().totals?.pending?.cents ? formatOrderMoney(sales().totals.pending.cents, 'EUR') : '—'}
            label="Waiting value"
          />
          <Metric value={sales().cardtrader?.username || '—'} label="CardTrader seller" />
        </MetricGrid>
      </Show>

      <Show when={!sales() && !error() && !notConnected()}>
        <DeskPanel title="1-DR sales"><div class="skeleton-line" /><div class="skeleton-line" /></DeskPanel>
      </Show>

      <Show when={oneDayReady() && sales() && !pendingItems().length && !heldItems().length}>
        <EmptyDesk
          title="No open 1-DR sales"
          lede="When CardTrader sells a card from your warehouse stock, it shows up here and in Sold history."
        />
      </Show>

      <Show when={oneDayReady() && showStock()}>
        <DeskPanel flush title={`CardTrader 1-DR · ${stockItems().length} card${stockItems().length === 1 ? '' : 's'}`}>
          <Show
            when={stockItems().length}
            fallback={<p class="dr-stock-empty">No warehouse cards yet. Run Sync CardTrader in Settings.</p>}
          >
            <div class="seller-listing-list" data-testid="cardtrader-1dr-all">
              <For each={stockItems()}>
                {(item) => (
                  <MiniCardTile
                    imageUrl={item.imageUrl}
                    name={item.cardName || 'Card'}
                    title={assetLabel(item)}
                    cardId={item.cardId || ''}
                    pricePkn={item.pricePkn}
                    href={item.cardId ? inventoryListingHref({ cardId: item.cardId }) : ''}
                    badge={item.quantity > 1 ? `×${item.quantity}` : ''}
                  />
                )}
              </For>
            </div>
          </Show>
        </DeskPanel>
      </Show>

      <Show when={oneDayReady() && pendingItems().length}>
        <DeskPanel flush title={`Waiting at CardTrader · ${sales().totals.pending.units} card${sales().totals.pending.units === 1 ? '' : 's'}`}>
          <div class="thread-list">
            <For each={pendingItems()}>{(item) => <SaleLine item={item} />}</For>
          </div>
        </DeskPanel>
      </Show>

      <Show when={oneDayReady() && heldItems().length}>
        <DeskPanel flush title={`With CardTrader · ${sales().totals.weekly.units} card${sales().totals.weekly.units === 1 ? '' : 's'}`}>
          <div class="thread-list">
            <For each={heldItems()}>{(item) => <SaleLine item={item} />}</For>
          </div>
        </DeskPanel>
      </Show>
    </div>
  );
}

/** /mypokoin/1dr. */
export default function CardTraderOneDay() {
  document.title = 'CardTrader 1-DR · Pokoin';
  return (
    <SignedIn from="/mypokoin/1dr">
      <OneDayDesk />
    </SignedIn>
  );
}
