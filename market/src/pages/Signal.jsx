import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchHome } from '../api.js';
import { loadCatalog, usdMoney } from '../catalog.js';
import { Alert, DeskPanel, EmptyDesk, Metric, MetricGrid, PageHead } from '../components/Desk.jsx';

export default function Signal() {
  const [home, setHome] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = 'Signal · Pokoin';
    let cancelled = false;
    Promise.allSettled([fetchHome([]), loadCatalog()])
      .then(([homeResult, catalogResult]) => {
        if (cancelled) return;
        if (homeResult.status === 'fulfilled') setHome(homeResult.value);
        if (catalogResult.status === 'fulfilled') setCatalog(catalogResult.value);
        const fails = [homeResult, catalogResult].filter((row) => row.status === 'rejected');
        if (fails.length === 2) {
          setError(fails[0].reason?.message || 'Signal failed.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const asking = Number(catalog?.totals?.usd) || 0;
  const copies = Number(catalog?.totals?.qty) || 0;
  const listings = Number(catalog?.totals?.listings) || (catalog?.items || []).length;
  const homeCards = home?.cards?.length || 0;

  return (
    <div className="page desk">
      <PageHead
        kicker="Market"
        title="Signal"
        lede="Honest snapshot. No fabricated 24h %. Dump asking is the Collectr catalog dump, not completed sales."
      >
        <Link className="btn" to="/marketplace">Shop</Link>
      </PageHead>
      <Alert>{error}</Alert>
      <MetricGrid>
        <Metric value={listings ? listings.toLocaleString() : '—'} label="Dump listings" />
        <Metric value={asking ? usdMoney(asking) : '—'} label="Dump asking" />
        <Metric value={copies ? copies.toLocaleString() : '—'} label="Dump copies" />
        <Metric value={homeCards || '—'} label="Home rail cards" />
      </MetricGrid>
      <div className="forum-desk">
        <DeskPanel title="Native shop">
          <p className="page-lede">GET listings with nativeOnly. Empty sales stay empty. Do not invent a 24h % from spread.</p>
          <div className="page-actions">
            <Link className="btn" to="/marketplace">Open marketplace</Link>
            <Link className="btn ghost" to="/marketplace/watchlist">Watchlist</Link>
          </div>
        </DeskPanel>
        <DeskPanel title="Catalog dump">
          {catalog ? (
            <>
              <p className="page-lede">candyext Collectr snapshot used by Explore and Portfolio. Asking is not a sale.</p>
              <div className="page-actions">
                <Link className="btn ghost" to="/marketplace/explore">Explore</Link>
                <Link className="btn ghost" to="/marketplace/portfolio">Portfolio</Link>
              </div>
            </>
          ) : (
            <EmptyDesk title="Dump not loaded" lede="Explore and Portfolio read public/data/catalog.json." />
          )}
        </DeskPanel>
      </div>
    </div>
  );
}
