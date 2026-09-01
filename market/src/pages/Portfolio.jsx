import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import CardArt from '../components/CardArt.jsx';
import DumpNav from '../components/DumpNav.jsx';
import { Alert, DeskPanel, EmptyDesk, Metric, MetricGrid, PageHead } from '../components/Desk.jsx';
import {
  catalogItemById,
  dumpItemHref,
  dumpMarketplaceHref,
  dumpSearchHref,
  finishLabel,
  loadCatalog,
  usdMoney,
} from '../catalog.js';

const PAGE = 40;

function useCountUp(target) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(target) || target <= 0) {
      setValue(0);
      return undefined;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / 800);
      const eased = 1 - (1 - progress) ** 3;
      setValue(target * eased);
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return value;
}

function Mini({ item }) {
  return (
    <Link className="port-mini" to={dumpItemHref(item)}>
      <CardArt src={item.img} alt="" loading="lazy" />
      <strong>{item.name}</strong>
      <span className="muted">{item.expansion}</span>
      <em>{usdMoney(item.usdTotal)}</em>
    </Link>
  );
}

function Rail({ title, items }) {
  const scroller = useRef(null);
  if (!items.length) {
    return null;
  }
  return (
    <section className="carousel">
      <div className="carousel-head">
        <h2>{title}</h2>
      </div>
      <div className="rail-wrap">
        <div className="carousel-track" ref={scroller}>
          {items.map((item) => <Mini key={item.id} item={item} />)}
        </div>
        <button
          className="rail-next"
          type="button"
          aria-label="Next"
          onClick={() => scroller.current?.scrollBy({
            left: Math.max(220, (scroller.current?.clientWidth || 0) * 0.8),
            behavior: 'smooth',
          })}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
        </button>
      </div>
    </section>
  );
}

function PortfolioList() {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef(null);
  const displayed = useCountUp(catalog?.totals?.usd || 0);

  useEffect(() => {
    document.title = 'Portfolio · Pokoin';
    let cancelled = false;
    loadCatalog()
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Catalog dump failed.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ranked = useMemo(() => {
    if (!catalog) {
      return { valuable: [], unit: [], copies: [], holdings: [] };
    }
    const items = catalog.items || [];
    const byTotal = [...items].sort((a, b) => b.usdTotal - a.usdTotal);
    const byUnit = [...items].sort((a, b) => b.usd - a.usd);
    const byQty = [...items].sort((a, b) => b.qty - a.qty || b.usdTotal - a.usdTotal);
    const needle = query.trim().toLowerCase();
    const holdings = needle
      ? byTotal.filter((item) => `${item.name} ${item.expansion} ${item.game}`.toLowerCase().includes(needle))
      : byTotal;
    return {
      valuable: byTotal.slice(0, 10),
      unit: byUnit.slice(0, 10),
      copies: byQty.slice(0, 10),
      holdings,
    };
  }, [catalog, query]);

  useEffect(() => {
    setShown(PAGE);
  }, [query]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !catalog) {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setShown((current) => Math.min(current + PAGE, ranked.holdings.length));
      }
    }, { rootMargin: '800px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [catalog, ranked.holdings.length, query]);

  if (error) {
    return (
      <div className="page desk">
        <PageHead kicker="Shop dump" title="Portfolio" />
        <DumpNav />
        <Alert>{error}</Alert>
      </div>
    );
  }

  if (!catalog) {
    return (
      <div className="page desk">
        <PageHead kicker="Portfolio" title="Shop snapshot" lede="Loading candyext CardTrader dump…" />
        <DumpNav />
      </div>
    );
  }

  const seller = catalog.seller || {};
  const games = catalog.games || [];
  const maxUsd = Math.max(1, ...games.map((game) => game.usd));
  const visible = ranked.holdings.slice(0, shown);
  const stamp = String(catalog.generated || '').slice(0, 10);

  return (
    <div className="page desk port-page">
      <PageHead
        kicker="Portfolio"
        title={[seller.username || 'RotationMotionTGC', seller.country, seller.pro ? 'PRO' : '']
          .filter(Boolean)
          .join(' · ')}
        lede={`Candyext dump of the public CardTrader shop (${stamp || '2026-08-30'}). Asking prices, not sold comps.`}
      />
      <DumpNav />
      <MetricGrid>
        <Metric value={usdMoney(displayed)} label="Asking" hint={usdMoney(catalog.totals.usd)} />
        <Metric value={(catalog.totals.qty || 0).toLocaleString('en-US')} label="Copies" />
        <Metric value={(catalog.totals.listings || 0).toLocaleString('en-US')} label="Listings" />
        <Metric value={seller.feedback != null ? `${seller.feedback}%` : '—'} label="Feedback" />
      </MetricGrid>

      <section>
        <div className="carousel-head">
          <h2>By game</h2>
        </div>
        <div className="port-games">
          {games.map((game) => (
            <div className="port-game" key={game.name}>
              <strong>{game.name}</strong>
              <div className="port-bar">
                <i style={{ width: `${(game.usd / maxUsd) * 100}%` }} />
              </div>
              <span>{usdMoney(game.usd)} · {(game.qty || 0).toLocaleString('en-US')} copies</span>
            </div>
          ))}
        </div>
      </section>

      <Rail title="Most valuable" items={ranked.valuable} />
      <Rail title="Highest unit price" items={ranked.unit} />
      <Rail title="Most copies" items={ranked.copies} />

      <section>
        <div className="shop-toolbar">
          <p className="result-count">Holdings</p>
          <input
            className="shop-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search this portfolio…"
            aria-label="Search this portfolio"
          />
        </div>
        <DeskPanel flush>
          <div className="port-holdings">
            {visible.map((item) => (
              <Link className="port-hold" key={item.id} to={dumpItemHref(item)}>
                <CardArt src={item.img} alt="" loading="lazy" />
                <div>
                  <strong>{item.name}</strong>
                  <span className="muted">
                    {item.game}
                    {' · '}
                    {item.expansion}
                    {' · '}
                    {finishLabel(item)}
                    {' · ×'}
                    {item.qty}
                  </span>
                </div>
                <em>{usdMoney(item.usdTotal)}</em>
              </Link>
            ))}
          </div>
        </DeskPanel>
        {ranked.holdings.length ? (
          <p className="page-lede">
            Showing {visible.length.toLocaleString('en-US')} of {ranked.holdings.length.toLocaleString('en-US')}
          </p>
        ) : (
          <EmptyDesk nested title="No holdings match" lede="Try a shorter name." />
        )}
        <div ref={sentinel} />
      </section>
    </div>
  );
}

function HoldingDetail() {
  const { listingId } = useParams();
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadCatalog()
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Catalog dump failed.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const item = catalog ? catalogItemById(catalog, listingId) : null;

  useEffect(() => {
    document.title = `${item?.name || 'Holding'} · Portfolio · Pokoin`;
  }, [item]);

  if (error) {
    return (
      <div className="page desk">
        <DumpNav />
        <Alert>{error}</Alert>
      </div>
    );
  }

  if (!catalog) {
    return (
      <div className="page desk">
        <p className="page-lede">Loading candyext CardTrader dump…</p>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="page desk">
        <Alert>That listing is not in the snapshot.</Alert>
        <Link className="btn ghost" to="/marketplace/portfolio">Back to portfolio</Link>
      </div>
    );
  }

  const live = dumpMarketplaceHref(item);

  return (
    <div className="page desk port-page">
      <nav className="crumbs">
        <Link to="/marketplace/portfolio">Portfolio</Link>
        <span>/</span>
        <span>{item.name}</span>
      </nav>
      <div className="port-detail">
        <CardArt src={item.img} alt={item.name} />
        <div>
          <p className="eyebrow">{item.game}</p>
          <h1>{item.name}</h1>
          <p className="muted">
            {item.expansion}
            {' · '}
            {finishLabel(item)}
            {item.language ? ` · ${item.language}` : ''}
            {item.rarity ? ` · ${item.rarity}` : ''}
            {' · ×'}
            {item.qty}
          </p>
          <p className="port-value">{usdMoney(item.usdTotal)}</p>
          <p className="muted">
            {usdMoney(item.usd)} asking each · CardTrader listing {item.id}
            {item.blueprint ? ` · blueprint ${item.blueprint}` : ''}
          </p>
          <p className="muted">Snapshot asking price from the candyext dump. Not a sold comp. Not live Pokoin inventory.</p>
          <p className="comp-subnav">
            <Link to={dumpSearchHref(item)}>Search marketplace</Link>
            {live.startsWith('/marketplace/en/cards/') ? <Link to={live}>Pokoin card {Number(item.blueprint) * 2}</Link> : null}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function Portfolio() {
  const { listingId } = useParams();
  return listingId ? <HoldingDetail /> : <PortfolioList />;
}
