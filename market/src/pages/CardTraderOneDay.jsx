import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { fetchCardTraderAssets, fetchCardTraderZero } from '../api.js';
import { useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';
import { inventoryListingHref } from '../inventory-listings.js';
import { formatOrderMoney } from '../order-status.js';
import { Alert, DeskPanel, EmptyDesk, Metric, MetricGrid, PageHead, SessionWait } from '../components/Desk.jsx';
import StockNav from '../components/StockNav.jsx';

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

function SaleLine({ item }) {
  const where = [item.expansion, item.collectorNumber ? `#${item.collectorNumber}` : ''].filter(Boolean).join(' · ');
  const when = day(item.soldAt);
  return (
    <div className="thread">
      <span className="thread-main">
        <strong className="thread-title">
          {item.cardId ? <Link to={inventoryListingHref(item)}>{item.name}</Link> : item.name}
          {item.quantity > 1 ? <span className="zero-qty"> ×{item.quantity}</span> : null}
          {' '}
          <span className="pill order-pill is-ct">CardTrader 1-DR</span>
        </strong>
        <span className="thread-meta">
          {[
            where,
            facets(item),
            item.lineCents != null ? formatOrderMoney(item.lineCents, item.currency) : '',
            item.orderCode ? `CT ${item.orderCode}` : '',
            when,
          ].filter(Boolean).join(' · ')}
        </span>
      </span>
    </div>
  );
}

export default function CardTraderOneDay() {
  const location = useLocation();
  const { ready, signedIn, getBearer } = useAuth();
  const [sales, setSales] = useState(null);
  const [assets, setAssets] = useState(null);
  const [error, setError] = useState('');
  const [notConnected, setNotConnected] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const token = await getBearer();
      const [saleResult, assetResult] = await Promise.all([
        fetchCardTraderZero(token),
        fetchCardTraderAssets(token).catch(() => null),
      ]);
      setNotConnected(false);
      setSales(saleResult);
      setAssets(assetResult);
    } catch (err) {
      if (err.body?.code === 'cardtrader_not_connected') setNotConnected(true);
      else setError(err.message || 'CardTrader 1-DR failed.');
    } finally {
      setLoading(false);
    }
  }, [getBearer]);

  useEffect(() => {
    document.title = 'CardTrader 1-DR · Pokoin';
    if (signedIn) load();
  }, [signedIn, load]);

  const pendingItems = useMemo(() => sales?.pending?.items || [], [sales]);
  const heldItems = useMemo(
    () => (sales?.weekly || []).flatMap((order) => order.items || []),
    [sales],
  );
  const oneDayReady = sales?.oneDayReady === true || assets?.oneDayReady === true;
  const warehouseCards = Math.max(0, Number(assets?.totals?.cards) || 0);

  if (!ready) return <SessionWait />;
  if (!signedIn) return <Navigate to={authFrom(location.pathname || '/mypokoin/1dr')} replace />;

  return (
    <div className="page desk">
      <PageHead
        kicker="Seller"
        title="CardTrader 1-DR"
        lede="CardTrader warehouses this stock and sells it. These sales are not a Zero shipment you pick and send. Each one also lands in Sold history with the CardTrader 1-DR tag."
      >
        <button className="btn ghost" type="button" onClick={load} disabled={loading || notConnected}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </PageHead>
      <StockNav />
      <Alert>{error}</Alert>

      {notConnected ? (
        <EmptyDesk title="Connect CardTrader first" lede="1-Day Ready sales are read from your CardTrader seller orders. Paste your CardTrader API token in Settings.">
          <Link className="btn" to="/mypokoin/settings">Settings</Link>
        </EmptyDesk>
      ) : null}

      {sales && !oneDayReady && !notConnected ? (
        <EmptyDesk title="This account is not 1-Day Ready" lede="CardTrader Zero shipments stay on their own tab. A 1-Day Ready token puts warehouse sales here.">
          <Link className="btn" to="/mypokoin/zero">CardTrader Zero</Link>
        </EmptyDesk>
      ) : null}

      {oneDayReady && sales ? (
        <MetricGrid>
          <Metric value={warehouseCards} label="Cards at CardTrader" hint="Warehouse stock" />
          <Metric
            value={sales.totals?.pending?.units || 0}
            label="Waiting at CardTrader"
            hint={`${sales.pending?.orderCount || 0} 1-DR sale${sales.pending?.orderCount === 1 ? '' : 's'}`}
          />
          <Metric
            value={sales.totals?.pending?.cents ? formatOrderMoney(sales.totals.pending.cents, 'EUR') : '—'}
            label="Waiting value"
          />
          <Metric value={sales.cardtrader?.username || '—'} label="CardTrader seller" />
        </MetricGrid>
      ) : null}

      {!sales && !error && !notConnected ? (
        <DeskPanel title="1-DR sales"><div className="skeleton-line" /><div className="skeleton-line" /></DeskPanel>
      ) : null}

      {oneDayReady && sales && !pendingItems.length && !heldItems.length ? (
        <EmptyDesk
          title="No open 1-DR sales"
          lede="When CardTrader sells a card from your warehouse stock, it shows up here and in Sold history."
        />
      ) : null}

      {oneDayReady && pendingItems.length ? (
        <DeskPanel flush title={`Waiting at CardTrader · ${sales.totals.pending.units} card${sales.totals.pending.units === 1 ? '' : 's'}`}>
          <div className="thread-list">
            {pendingItems.map((item) => <SaleLine key={`${item.orderId}-${item.itemId}`} item={item} />)}
          </div>
        </DeskPanel>
      ) : null}

      {oneDayReady && heldItems.length ? (
        <DeskPanel flush title={`With CardTrader · ${sales.totals.weekly.units} card${sales.totals.weekly.units === 1 ? '' : 's'}`}>
          <div className="thread-list">
            {heldItems.map((item) => <SaleLine key={`${item.orderId}-${item.itemId}`} item={item} />)}
          </div>
        </DeskPanel>
      ) : null}
    </div>
  );
}
