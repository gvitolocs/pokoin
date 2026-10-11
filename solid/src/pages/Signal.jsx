import { createSignal, onSettled, Show } from 'solid-js';
import { fetchHome, fetchPortfolio, formatPkn } from '@market/api.js';
import { Alert, DeskPanel, EmptyDesk, Metric, MetricGrid, PageHead } from '../components/Desk.jsx';

/** /marketplace/signal (market/src/pages/Signal.jsx): honest native-shop snapshot. */
export default function Signal() {
  const [home, setHome] = createSignal(null);
  const [portfolio, setPortfolio] = createSignal(null);
  const [error, setError] = createSignal('');

  onSettled(() => {
    document.title = 'Signal · Pokoin';
    let cancelled = false;
    Promise.allSettled([fetchHome([]), fetchPortfolio()]).then(([homeResult, portfolioResult]) => {
      if (cancelled) return;
      if (homeResult.status === 'fulfilled') setHome(() => homeResult.value);
      if (portfolioResult.status === 'fulfilled') setPortfolio(() => portfolioResult.value);
      const fails = [homeResult, portfolioResult].filter((row) => row.status === 'rejected');
      if (fails.length === 2) setError(fails[0].reason?.message || 'Signal failed.');
    });
    return () => {
      cancelled = true;
    };
  });

  const asking = () => Number(portfolio()?.totals?.pkn) || 0;
  const copies = () => Number(portfolio()?.totals?.qty) || 0;
  const listings = () => Number(portfolio()?.totals?.listings) || 0;
  const homeCards = () => home()?.cards?.length || 0;

  return (
    <div class="page desk">
      <PageHead
        kicker="Market"
        title="Signal"
        lede="Honest snapshot. No fabricated 24h %. Asking is live native PKN, not completed sales."
      >
        <a class="btn" href="/marketplace">Shop</a>
      </PageHead>
      <Alert>{error()}</Alert>
      <MetricGrid>
        <Metric value={listings() ? listings().toLocaleString() : '—'} label="Native listings" />
        <Metric value={asking() ? (formatPkn(asking()) || '—') : '—'} label="Native asking" />
        <Metric value={copies() ? copies().toLocaleString() : '—'} label="Copies" />
        <Metric value={homeCards() || '—'} label="Home rail cards" />
      </MetricGrid>
      <div class="forum-desk">
        <DeskPanel title="Native shop">
          <p class="page-lede">GET /api/marketplace-portfolio. Catalog + native PKN overlay. Empty asking stays — . Do not invent a 24h % from spread.</p>
          <div class="page-actions">
            <a class="btn" href="/marketplace">Open marketplace</a>
            <a class="btn ghost" href="/marketplace/watchlist">Watchlist</a>
          </div>
        </DeskPanel>
        <DeskPanel title="Holdings">
          <Show
            when={portfolio()}
            fallback={<EmptyDesk title="Portfolio API not loaded" lede="GET /api/marketplace-portfolio." />}
          >
            <p class="page-lede">Explore and Portfolio read the Pokoin catalog in PKN. Art is cdn.pokoin.com.</p>
            <div class="page-actions">
              <a class="btn ghost" href="/marketplace/explore">Explore</a>
              <a class="btn ghost" href="/marketplace/portfolio">Portfolio</a>
            </div>
          </Show>
        </DeskPanel>
      </div>
    </div>
  );
}
