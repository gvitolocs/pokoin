import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchHome } from '../api.js';
import { loadCatalog, usdMoney } from '../catalog.js';

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
    <div className="page app-page">
      <div className="comp-head">
        <div>
          <p className="eyebrow">Market</p>
          <h1>Marketplace Signal</h1>
          <p className="muted">Honest snapshot. No fabricated 24h %. Dump asking is the candyext Collectr catalog, not completed sales.</p>
        </div>
        <Link className="more" to="/marketplace" style={{ margin: 0 }}>Shop</Link>
      </div>
      {error ? <p className="status error">{error}</p> : null}
      <div className="stat-strip">
        <div><strong>{listings ? listings.toLocaleString() : '—'}</strong><span>Dump listings</span></div>
        <div><strong>{asking ? usdMoney(asking) : '—'}</strong><span>Dump asking</span></div>
        <div><strong>{copies ? copies.toLocaleString() : '—'}</strong><span>Dump copies</span></div>
        <div><strong>{homeCards || '—'}</strong><span>Home rail cards</span></div>
      </div>
      <p className="muted">
        Native shop uses GET listings with nativeOnly. Explore the
        {' '}
        <Link to="/marketplace/explore">dump</Link>
        {' '}
        or
        {' '}
        <Link to="/marketplace/portfolio">portfolio</Link>
        .
      </p>
    </div>
  );
}
