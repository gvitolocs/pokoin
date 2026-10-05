import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useMatch } from 'react-router-dom';
import { exportStockCsv, fetchPricingStrategies, fetchSellerListings } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useSellerCurrency } from '../use-seller-currency.js';
import { formatSellerPrice } from '../seller-currency.js';
import { Alert, DeskPanel, EmptyDesk, PageHead, SessionWait } from '../components/Desk.jsx';
import CollectionHoldings from '../components/CollectionHoldings.jsx';
import InventoryBoard from '../components/InventoryBoard.jsx';
import LocationBoard from '../components/LocationBoard.jsx';
import PricingStrategies, { PricerDefaults } from '../components/PricingStrategies.jsx';
import StockNav from '../components/StockNav.jsx';
import { inventoryRowsForLocation, liveInventoryListings } from '../inventory-listings.js';

const FORMATS = [
  { id: 'powertools', label: 'Power Tools' },
  { id: 'cardmarket', label: 'Cardmarket' },
  { id: 'cardtrader', label: 'CardTrader' },
  { id: 'tcgplayer', label: 'TCGPlayer' },
];

// Paint the board off the first raw page, then top up the rest in the
// background — one round trip to first row instead of the full inventory.
const INVENTORY_FIRST_PAGE = 200;
const INVENTORY_PAGE_LIMIT = 1000;

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Pokemon seller stock desk — live path is /mypokoin (legacy /inventory
 * redirects). The Collection tab holds what you own (legacy /collection and
 * /nft redirect to it).
 */
export default function Inventory() {
  const location = useLocation();
  const onImportTab = Boolean(useMatch({ path: '/mypokoin/import', end: true }));
  const onSettingsTab = Boolean(useMatch({ path: '/mypokoin/settings', end: true }));
  const onCollectionTab = Boolean(useMatch({ path: '/mypokoin/collection', end: true }));
  const locationMatch = useMatch({ path: '/mypokoin/location/:location', end: false });
  let locationName = locationMatch ? decodeURIComponent(locationMatch.params.location || '') : '';
  // The auth bounce can double-encode the · separator — decode until stable.
  if (locationName.includes('%')) {
    try { locationName = decodeURIComponent(locationName); } catch (_) { /* keep */ }
  }
  const { user, ready, signedIn, profile, getBearer } = useAuth();
  // PKN opt-out sellers read their prices in local currency.
  const { currency: priceCurrency } = useSellerCurrency();
  const formatPrice = (pkn) => formatSellerPrice(pkn, priceCurrency);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [askFormat, setAskFormat] = useState(false);
  const [busy, setBusy] = useState('');
  // Bumped by reload() so a stale background top-up stops writing rows.
  const inventorySeq = useRef(0);

  async function topUpInventory(uid, token, gen) {
    let offset = INVENTORY_FIRST_PAGE;
    for (;;) {
      let data;
      try {
        data = await fetchSellerListings(uid, token, { limit: INVENTORY_PAGE_LIMIT, offset });
      } catch (_) {
        return;
      }
      if (gen !== inventorySeq.current) return;
      const raw = data.listings || data.items || [];
      if (!raw.length) return;
      const filtered = liveInventoryListings(raw);
      setRows((current) => {
        const base = Array.isArray(current) ? current : [];
        const known = new Set(base.map((row) => String(row.id || row.listingId || '')));
        const fresh = filtered.filter((row) => !known.has(String(row.id || row.listingId || '')));
        return fresh.length ? [...base, ...fresh] : current;
      });
      if (raw.length < INVENTORY_PAGE_LIMIT) return;
      offset += raw.length;
    }
  }

  async function reload() {
    const uid = user?.uid || profile?.uid;
    if (!signedIn || !uid) return;
    const token = await getBearer();
    inventorySeq.current += 1;
    const data = await fetchSellerListings(uid, token, { limit: 1000 });
    setRows(liveInventoryListings(data.listings || data.items || []));
  }

  useEffect(() => {
    document.title = onCollectionTab
      ? 'Collection · MyPokoin'
      : onSettingsTab
      ? 'Settings · MyPokoin'
      : locationName
      ? `${locationName} · MyPokoin`
      : (onImportTab ? 'Export · MyPokoin' : 'MyPokoin · Pokoin');
    const uid = user?.uid || profile?.uid;
    // The Collection tab loads holdings, not listings.
    if (!signedIn || !uid || onCollectionTab) return undefined;
    let cancelled = false;
    const gen = ++inventorySeq.current;
    getBearer()
      .then(async (token) => {
        const data = await fetchSellerListings(uid, token, { limit: INVENTORY_FIRST_PAGE });
        if (cancelled) return;
        setRows(liveInventoryListings(data.listings || data.items || []));
        topUpInventory(uid, token, gen).catch(() => {});
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Listings failed.');
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, user?.uid, profile?.uid, getBearer, onImportTab, locationName, onSettingsTab, onCollectionTab]);

  // Pricer defaults feed the board's market column and source preselect.
  const [pricerDefaults, setPricerDefaults] = useState(null);
  useEffect(() => {
    if (!signedIn || onImportTab || onCollectionTab) return undefined;
    let cancelled = false;
    getBearer()
      .then((token) => fetchPricingStrategies(token))
      .then((data) => {
        if (!cancelled) setPricerDefaults(data.pricerSettings || {});
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [signedIn, getBearer, onImportTab, onSettingsTab, onCollectionTab]);

  async function onExport(formatId) {
    setError('');
    setBusy(formatId);
    try {
      const token = await getBearer();
      const blob = await exportStockCsv(formatId, token);
      downloadBlob(blob, `pokoin-stock-${formatId}.csv`);
      setAskFormat(false);
    } catch (err) {
      setError(err.message || 'Export failed.');
    } finally {
      setBusy('');
    }
  }

  if (!ready) return <SessionWait />;
  if (!signedIn) {
    return <Navigate to={`/auth?from=${encodeURIComponent(location.pathname || '/mypokoin')}`} replace />;
  }

  const onListings = !onImportTab && !onSettingsTab && !onCollectionTab;

  return (
    <div className="page desk">
      <PageHead
        kicker="Seller"
        title="MyPokoin"
      >
        <Link className="btn" to="/inventory/scan">Scan cards</Link>
        <Link className="btn ghost" to="/marketplace">List a card</Link>
      </PageHead>
      <StockNav forceActive={locationName ? 'Listings' : ''} />
      <Alert>{error}</Alert>

      {onImportTab ? (
        <DeskPanel title="Export stock">
          <div className="stock-csv-bar">
            {askFormat ? (
              <div className="stock-csv-bar" role="group" aria-label="Export format">
                {FORMATS.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className="btn"
                    disabled={Boolean(busy)}
                    onClick={() => onExport(row.id)}
                  >
                    {busy === row.id ? 'Exporting…' : row.label}
                  </button>
                ))}
              </div>
            ) : (
              <button type="button" className="btn ghost" onClick={() => setAskFormat(true)} disabled={Boolean(busy)}>
                Export CSV
              </button>
            )}
            <Link className="btn" to="/mypokoin/spreadsheet">Import in spreadsheet</Link>
          </div>
        </DeskPanel>
      ) : null}

      {onCollectionTab ? <CollectionHoldings /> : null}

      {!onImportTab && !onCollectionTab && rows == null && !error ? (
        <DeskPanel title="Listings"><div className="skeleton-line" /><div className="skeleton-line" /></DeskPanel>
      ) : null}
      {onSettingsTab ? (
        <>
          <DeskPanel title="Pricer defaults">
            <PricerDefaults
              settings={pricerDefaults}
              onSaved={(next) => setPricerDefaults(next)}
            />
          </DeskPanel>
          <DeskPanel title="Pricing strategies">
            <PricingStrategies onApplied={() => reload().catch(() => {})} />
          </DeskPanel>
        </>
      ) : null}
      {onListings && rows && !rows.length ? (
        <EmptyDesk
          title={locationName ? `Nothing stored in ${locationName}` : 'No live listings'}
          lede={locationName ? 'Move a listing into this location from its card desk, or scan a new pile.' : 'Scan a pile with your phone, or import a spreadsheet.'}>
          <Link className="btn" to="/inventory/scan">Scan cards</Link>
          <Link className="btn ghost" to="/mypokoin/spreadsheet">Sell via spreadsheet</Link>
          <Link className="btn ghost" to="/mypokoin/import">Export CSV</Link>
          <Link className="btn ghost" to="/marketplace">Find a card</Link>
        </EmptyDesk>
      ) : null}
      {onListings && locationName && rows?.length ? (
        <LocationBoard
          rows={inventoryRowsForLocation(rows, locationName)}
          location={locationName}
          formatPrice={formatPrice}
        />
      ) : null}
      {onListings && !locationName && rows?.length ? (
        <InventoryBoard
          rows={rows}
          formatPrice={formatPrice}
          defaultSource={pricerDefaults?.defaultSource || ''}
          autoMarketColumn={pricerDefaults?.autoMarketColumn === true}
        />
      ) : null}
    </div>
  );
}
