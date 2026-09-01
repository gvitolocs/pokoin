import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import CardArt from '../components/CardArt.jsx';
import DumpNav from '../components/DumpNav.jsx';
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
      <div className="page">
        <p className="status error">{error}</p>
      </div>
    );
  }

  const visible = filtered.slice(0, shown);

  return (
    <div className="page port-page">
      <DumpNav />
      <p className="eyebrow">Find a product</p>
      <h1>Explore</h1>
      <form
        className="explore-find"
        onSubmit={(event) => {
          event.preventDefault();
          setShown(PAGE);
        }}
      >
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search any sealed or unsealed product…"
          aria-label="Search dump products"
        />
        <button className="more" type="submit" style={{ margin: 0 }}>Search</button>
        <button
          className="more"
          type="button"
          style={{ margin: 0 }}
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
      </form>
      <div className="comp-toolbar">
        <label className="sort">
          Sort by
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="value">Most valuable</option>
            <option value="name">Name</option>
            <option value="qty">Most copies</option>
          </select>
        </label>
      </div>
      <div className="explore-layout">
        <aside className="explore-filters" aria-label="Filters">
          <div>
            <h2>Watchlist</h2>
            <label>
              <input type="checkbox" checked={watchOnly} onChange={(event) => setWatchOnly(event.target.checked)} />
              Dump watchlist only
            </label>
          </div>
          <div>
            <h2>Product type</h2>
            {['all', 'cards', 'sealed'].map((value) => (
              <label key={value}>
                <input type="radio" name="explore-type" checked={type === value} onChange={() => setType(value)} />
                {value === 'all' ? 'All' : value === 'cards' ? 'Cards only' : 'Sealed only'}
              </label>
            ))}
          </div>
          <div>
            <h2>Price (USD)</h2>
            <div className="explore-price">
              <input type="number" min="0" step="0.01" placeholder="Min" value={min} onChange={(event) => setMin(event.target.value)} />
              <span>to</span>
              <input type="number" min="0" step="0.01" placeholder="Max" value={max} onChange={(event) => setMax(event.target.value)} />
            </div>
          </div>
          <div>
            <h2>Language</h2>
            {langNames.map((lang) => (
              <label key={lang}>
                <input type="checkbox" checked={langs.has(lang)} onChange={() => toggleSet(setLangs, lang)} />
                {lang}
              </label>
            ))}
          </div>
          <div>
            <h2>Category</h2>
            {gameNames.map((game) => (
              <label key={game}>
                <input type="checkbox" checked={games.has(game)} onChange={() => toggleSet(setGames, game)} />
                {game}
              </label>
            ))}
          </div>
        </aside>
        <section>
          {!catalog ? (
            <p className="muted">Loading candyext CardTrader dump…</p>
          ) : (
            <p className="muted">
              Showing {visible.length.toLocaleString('en-US')} of {filtered.length.toLocaleString('en-US')}
              {' · '}
              {(catalog.totals.qty || 0).toLocaleString('en-US')} copies in shop
            </p>
          )}
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
          {catalog && !filtered.length ? <p className="muted">No products match those filters.</p> : null}
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
