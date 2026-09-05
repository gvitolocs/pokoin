import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchHome, fetchPortfolio, formatPkn } from '../api.js';
import { Alert, DeskPanel, EmptyDesk, Metric, MetricGrid, PageHead } from '../components/Desk.jsx';

export default function Signal() {
  const [home, setHome] = useState(null);
  const [portfolio, setPortfolio] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = 'Signal · Pokoin';
    let cancelled = false;
    Promise.allSettled([fetchHome([]), fetchPortfolio()])
      .then(([homeResult, portfolioResult]) => {
        if (cancelled) return;
        if (homeResult.status === 'fulfilled') setHome(homeResult.value);
        if (portfolioResult.status === 'fulfilled') setPortfolio(portfolioResult.value);
        const fails = [homeResult, portfolioResult].filter((row) => row.status === 'rejected');
        if (fails.length === 2) {
          setError(fails[0].reason?.message || 'Signal failed.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const asking = Number(portfolio?.totals?.pkn) || 0;
  const copies = Number(portfolio?.totals?.qty) || 0;
  const listings = Number(portfolio?.totals?.listings) || 0;
  const homeCards = home?.cards?.length || 0;

  return (
    <div className="page desk">
      <PageHead
        kicker="Market"
        title="Signal"
        lede="Honest snapshot. No fabricated 24h %. Asking is live native PKN, not completed sales."
      >
        <Link className="btn" to="/marketplace">Shop</Link>
      </PageHead>
      <Alert>{error}</Alert>
      <MetricGrid>
        <Metric value={listings ? listings.toLocaleString() : '—'} label="Native listings" />
        <Metric value={asking ? (formatPkn(asking) || '—') : '—'} label="Native asking" />
        <Metric value={copies ? copies.toLocaleString() : '—'} label="Copies" />
        <Metric value={homeCards || '—'} label="Home rail cards" />
      </MetricGrid>
      <div className="forum-desk">
        <DeskPanel title="Native shop">
          <p className="page-lede">GET /api/marketplace-portfolio. Catalog + native PKN overlay. Empty asking stays — . Do not invent a 24h % from spread.</p>
          <div className="page-actions">
            <Link className="btn" to="/marketplace">Open marketplace</Link>
            <Link className="btn ghost" to="/marketplace/watchlist">Watchlist</Link>
          </div>
        </DeskPanel>
        <DeskPanel title="Holdings">
          {portfolio ? (
            <>
              <p className="page-lede">Explore and Portfolio read the Pokoin catalog in PKN. Art is cdn.pokoin.com.</p>
              <div className="page-actions">
                <Link className="btn ghost" to="/marketplace/explore">Explore</Link>
                <Link className="btn ghost" to="/marketplace/portfolio">Portfolio</Link>
              </div>
            </>
          ) : (
            <EmptyDesk title="Portfolio API not loaded" lede="GET /api/marketplace-portfolio." />
          )}
        </DeskPanel>
      </div>
    </div>
  );
}
