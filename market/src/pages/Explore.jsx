import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import CardArt from '../components/CardArt.jsx';
import DumpNav from '../components/DumpNav.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import {
  dumpItemHref,
  dumpWatchIds,
  finishLabel,
  isSealed,
  loadCatalog,
  toggleDumpWatch,
  usdMoney,
} from '../catalog.js';

const PAGE = 48;

export default function Explore() {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('value');
  const [type, setType] = useState('all');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [watchOnly, setWatchOnly] = useState(false);
  const [games, setGames] = useState(() => new Set());
  const [langs, setLangs] = useState(() => new Set());
  const [shown, setShown] = useState(PAGE);
  const [watchTick, setWatchTick] = useState(0);
  const sentinel = useRef(null);

  useEffect(() => {
    document.title = 'Explore · Pokoin';
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

  const gameNames = catalog?.games?.map((row) => row.name) || [];
  const langNames = useMemo(() => {
    if (!catalog) return [];
    return [...new Set(catalog.items.map((item) => item.language).filter(Boolean))].sort();
  }, [catalog]);

  const filtered = useMemo(() => {
    if (!catalog) return [];
    const needle = query.trim().toLowerCase();
    const minUsd = Number(min) || 0;
    const maxUsd = Number(max) || Infinity;
    const watched = new Set(dumpWatchIds());
    const rows = catalog.items.filter((item) => {
      if (needle && !`${item.name} ${item.expansion} ${item.game}`.toLowerCase().includes(needle)) return false;
      if (type === 'cards' && isSealed(item)) return false;
      if (type === 'sealed' && !isSealed(item)) return false;
      if (item.usd < minUsd || item.usd > maxUsd) return false;
      if (watchOnly && !watched.has(String(item.id))) return false;
      if (games.size && !games.has(item.game)) return false;
      if (langs.size && item.language && !langs.has(item.language)) return false;
      return true;
    });
    rows.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'qty') return b.qty - a.qty || b.usdTotal - a.usdTotal;
      return b.usdTotal - a.usdTotal;
    });
    return rows;
  }, [catalog, query, sort, type, min, max, watchOnly, games, langs, watchTick]);

  useEffect(() => {
    setShown(PAGE);
  }, [query, sort, type, min, max, watchOnly, games, langs]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !catalog) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setShown((current) => Math.min(current + PAGE, filtered.length));
      }
    }, { rootMargin: '800px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [catalog, filtered.length, query, type]);

  function toggleSet(setter, value) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  if (error) {
    return (
      <div className="page desk">
        <PageHead kicker="Shop dump" title="Explore" />
        <DumpNav />
        <Alert>{error}</Alert>
      </div>
    );
  }

  const visible = filtered.slice(0, shown);

  return (
    <div className="page desk port-page">
      <PageHead
        kicker="Shop dump"
        title="Explore"
        lede="Candyext CardTrader snapshot. Asking prices, not sold comps."
      />
      <DumpNav />
      <form
        className="shop-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setShown(PAGE);
        }}
      >
        <p className="result-count">
          {!catalog
            ? 'Loading dump…'
            : (
              <>
                Showing <strong>{visible.length.toLocaleString('en-US')}</strong>
                {' of '}
                {filtered.length.toLocaleString('en-US')}
                {' · '}
                {(catalog.totals.qty || 0).toLocaleString('en-US')} copies
              </>
            )}
        </p>
        <div className="toolbar-right">
          <input
            className="shop-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sealed or singles…"
            aria-label="Search dump products"
          />
          <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort">
            <option value="value">Most valuable</option>
            <option value="name">Name</option>
            <option value="qty">Most copies</option>
          </select>
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              setQuery('');
              setType('all');
              setMin('');
              setMax('');
              setWatchOnly(false);
              setGames(new Set());
              setLangs(new Set());
              setSort('value');
            }}
          >
            Clear
          </button>
        </div>
      </form>
      <div className="explore-layout">
        <aside className="filter-rail" aria-label="Filters">
          <div className="filter-group">
            <span className="filter-label">Watchlist</span>
            <label className="filter-option">
              <input type="checkbox" checked={watchOnly} onChange={(event) => setWatchOnly(event.target.checked)} />
              Dump watchlist only
            </label>
          </div>
          <div className="filter-group">
            <span className="filter-label">Product type</span>
            {['all', 'cards', 'sealed'].map((value) => (
              <label className="filter-option" key={value}>
                <input type="radio" name="explore-type" checked={type === value} onChange={() => setType(value)} />
                {value === 'all' ? 'All' : value === 'cards' ? 'Cards only' : 'Sealed only'}
              </label>
            ))}
          </div>
          <div className="filter-group">
            <span className="filter-label">Price (USD)</span>
            <div className="explore-price">
              <input type="number" min="0" step="0.01" placeholder="Min" value={min} onChange={(event) => setMin(event.target.value)} />
              <span>to</span>
              <input type="number" min="0" step="0.01" placeholder="Max" value={max} onChange={(event) => setMax(event.target.value)} />
            </div>
          </div>
          <div className="filter-group">
            <span className="filter-label">Language</span>
            {langNames.map((lang) => (
              <label className="filter-option" key={lang}>
                <input type="checkbox" checked={langs.has(lang)} onChange={() => toggleSet(setLangs, lang)} />
                {lang}
              </label>
            ))}
          </div>
          <div className="filter-group">
            <span className="filter-label">Category</span>
            {gameNames.map((game) => (
              <label className="filter-option" key={game}>
                <input type="checkbox" checked={games.has(game)} onChange={() => toggleSet(setGames, game)} />
                {game}
              </label>
            ))}
          </div>
        </aside>
        <section>
          {catalog && !filtered.length ? (
            <EmptyDesk title="No products match" lede="Clear filters or search a different name." />
          ) : (
            <div className="explore-grid">
              {visible.map((item) => (
                <article className="explore-card" key={item.id}>
                  <Link to={dumpItemHref(item)}>
                    <CardArt src={item.img} alt="" loading="lazy" />
                    <strong>{item.name}</strong>
                    <span className="muted">{[item.expansion, item.rarity].filter(Boolean).join(' · ')}</span>
                    <span className="muted">{finishLabel(item)}{item.qty > 1 ? ` · ×${item.qty}` : ''}</span>
                    <em>{usdMoney(item.usd)}</em>
                  </Link>
                  <button
                    className={dumpWatchedAt(item.id, watchTick) ? 'explore-add on' : 'explore-add'}
                    type="button"
                    aria-label="Add to dump watchlist"
                    onClick={() => {
                      toggleDumpWatch(item.id);
                      setWatchTick((value) => value + 1);
                    }}
                  >
                    +
                  </button>
                </article>
              ))}
            </div>
          )}
          <div ref={sentinel} />
        </section>
      </div>
    </div>
  );
}

function dumpWatchedAt(id, tick) {
  void tick;
  return dumpWatchIds().includes(String(id));
}
