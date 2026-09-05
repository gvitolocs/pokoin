import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { cardHref, fetchPortfolio, formatPkn, imageSrc } from '../api.js';
import { game } from '../game.js';
import CardArt from '../components/CardArt.jsx';
import DumpNav from '../components/DumpNav.jsx';
import { Alert, DeskPanel, EmptyDesk, Metric, MetricGrid, PageHead } from '../components/Desk.jsx';

const PAGE = 40;

function holdingHref(item) {
  return item?.id ? `/marketplace/portfolio/${item.id}` : '/marketplace/portfolio';
}

function money(value) {
  return formatPkn(value) || '—';
}

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
    <Link className="port-mini" to={holdingHref(item)}>
      <CardArt src={imageSrc(item, 'hero')} alt="" loading="lazy" />
      <strong>{item.name}</strong>
      <span className="muted">{item.expansion}</span>
      <em>{money(item.totalPkn)}</em>
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
  const site = game();
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef(null);
  const displayed = useCountUp(catalog?.totals?.pkn || 0);

  useEffect(() => {
    document.title = 'Portfolio · Pokoin';
    let cancelled = false;
    fetchPortfolio()
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Portfolio failed.');
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
    const byTotal = [...items].sort((a, b) => (b.totalPkn || 0) - (a.totalPkn || 0));
    const byUnit = [...items].sort((a, b) => (b.pricePkn || 0) - (a.pricePkn || 0));
    const byQty = [...items].sort((a, b) => (b.qty || 0) - (a.qty || 0) || (b.totalPkn || 0) - (a.totalPkn || 0));
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
        <PageHead kicker="Market" title="Portfolio" />
        <DumpNav />
        <Alert>{error}</Alert>
      </div>
    );
  }

  if (!catalog) {
    return (
      <div className="page desk">
        <PageHead kicker="Portfolio" title="Live asking" lede="Loading Pokoin catalog…" />
        <DumpNav />
      </div>
    );
  }

  const sets = catalog.sets || [];
  const maxPkn = Math.max(1, ...sets.map((row) => row.pkn || 0));
  const visible = ranked.holdings.slice(0, shown);

  return (
    <div className="page desk port-page">
      <PageHead
        kicker="Portfolio"
        title={`${site.brand} · live listings`}
        lede="Pokoin catalog in PKN. Art from cdn.pokoin.com. Asking overlays live native listings when they exist."
      />
      <DumpNav />
      <MetricGrid>
        <Metric value={money(displayed)} label="Asking" hint={money(catalog.totals.pkn)} />
        <Metric value={(catalog.totals.qty || 0).toLocaleString('en-US')} label="Copies" />
        <Metric value={(catalog.totals.listings || 0).toLocaleString('en-US')} label="Listings" />
        <Metric value={(catalog.totals.cards || 0).toLocaleString('en-US')} label="Cards" />
      </MetricGrid>

      {sets.length ? (
        <section>
          <div className="carousel-head">
            <h2>By set</h2>
          </div>
          <div className="port-games">
            {sets.map((row) => (
              <div className="port-game" key={row.name}>
                <strong>{row.name}</strong>
                <div className="port-bar">
                  <i style={{ width: `${((row.pkn || 0) / maxPkn) * 100}%` }} />
                </div>
                <span>{money(row.pkn)} · {(row.qty || 0).toLocaleString('en-US')} copies</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

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
              <Link className="port-hold" key={item.id} to={holdingHref(item)}>
                <CardArt src={imageSrc(item, 'hero')} alt="" loading="lazy" />
                <div>
                  <strong>{item.name}</strong>
                  <span className="muted">
                    {item.game}
                    {' · '}
                    {item.expansion}
                    {item.number ? ` · ${item.number}` : ''}
                    {item.condition ? ` · ${item.condition}` : ''}
                    {' · ×'}
                    {item.qty}
                  </span>
                </div>
                <em>{money(item.totalPkn)}</em>
              </Link>
            ))}
          </div>
        </DeskPanel>
        {ranked.holdings.length ? (
          <p className="page-lede">
            Showing {visible.length.toLocaleString('en-US')} of {ranked.holdings.length.toLocaleString('en-US')}
          </p>
        ) : (
          <EmptyDesk nested title="No Pokoin cards" lede="Catalog is empty for this game.">
            <Link className="btn" to="/marketplace">Shop</Link>
          </EmptyDesk>
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
    fetchPortfolio({ id: listingId })
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Portfolio failed.');
      });
    return () => {
      cancelled = true;
    };
  }, [listingId]);

  const item = (catalog?.items || []).find((row) => String(row.id) === String(listingId))
    || catalog?.items?.[0]
    || null;

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
        <p className="page-lede">Loading live PKN holding…</p>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="page desk">
        <Alert>No Pokoin card for that id.</Alert>
        <Link className="btn ghost" to="/marketplace/portfolio">Back to portfolio</Link>
      </div>
    );
  }

  const live = item.canonicalPath || cardHref(item);

  return (
    <div className="page desk port-page">
      <nav className="crumbs">
        <Link to="/marketplace/portfolio">Portfolio</Link>
        <span>/</span>
        <span>{item.name}</span>
      </nav>
      <div className="port-detail">
        <CardArt src={imageSrc(item, 'hero')} alt={item.name} />
        <div>
          <p className="eyebrow">{item.game}</p>
          <h1>{item.name}</h1>
          <p className="muted">
            {item.expansion}
            {item.number ? ` · ${item.number}` : ''}
            {item.condition ? ` · ${item.condition}` : ''}
            {item.language ? ` · ${item.language}` : ''}
            {' · ×'}
            {item.qty}
          </p>
          <p className="port-value">{money(item.totalPkn)}</p>
          <p className="muted">
            {money(item.pricePkn)} floor · {item.listingCount} native listing{item.listingCount === 1 ? '' : 's'}
          </p>
          <p className="muted">Pokoin PKN. Catalog art from cdn.pokoin.com. Not USD. Not a CardTrader leftover image.</p>
          <p className="comp-subnav">
            <Link to={live}>Open card desk</Link>
            <Link to="/marketplace/portfolio">All holdings</Link>
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
