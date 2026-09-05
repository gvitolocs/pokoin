import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchPortfolio, formatPkn, imageSrc } from '../api.js';
import CardArt from '../components/CardArt.jsx';
import DumpNav from '../components/DumpNav.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import { dumpWatchIds, toggleDumpWatch } from '../catalog.js';

const PAGE = 48;

function money(value) {
  return formatPkn(value) || '—';
}

export default function Explore() {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('value');
  const [type, setType] = useState('all');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [watchOnly, setWatchOnly] = useState(false);
  const [langs, setLangs] = useState(() => new Set());
  const [shown, setShown] = useState(PAGE);
  const [watchTick, setWatchTick] = useState(0);
  const sentinel = useRef(null);

  useEffect(() => {
    document.title = 'Explore · Pokoin';
    let cancelled = false;
    fetchPortfolio()
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Explore failed.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const langNames = useMemo(() => {
    if (!catalog) return [];
    return [...new Set((catalog.items || []).map((item) => item.language).filter(Boolean))].sort();
  }, [catalog]);

  const filtered = useMemo(() => {
    if (!catalog) return [];
    const needle = query.trim().toLowerCase();
    const minPkn = Number(min) || 0;
    const maxPkn = Number(max) || Infinity;
    const watched = new Set(dumpWatchIds());
    const rows = (catalog.items || []).filter((item) => {
      if (needle && !`${item.name} ${item.expansion} ${item.game}`.toLowerCase().includes(needle)) return false;
      if (type === 'cards' && item.sealed) return false;
      if (type === 'sealed' && !item.sealed) return false;
      if ((item.pricePkn || 0) < minPkn || (item.pricePkn || 0) > maxPkn) return false;
      if (watchOnly && !watched.has(String(item.id))) return false;
      if (langs.size && item.language && !langs.has(item.language)) return false;
      return true;
    });
    rows.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'qty') return (b.qty || 0) - (a.qty || 0) || (b.totalPkn || 0) - (a.totalPkn || 0);
      return (b.totalPkn || 0) - (a.totalPkn || 0);
    });
    return rows;
  }, [catalog, query, sort, type, min, max, watchOnly, langs, watchTick]);

  useEffect(() => {
    setShown(PAGE);
  }, [query, sort, type, min, max, watchOnly, langs]);

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
        <PageHead kicker="Market" title="Explore" />
        <DumpNav />
        <Alert>{error}</Alert>
      </div>
    );
  }

  const visible = filtered.slice(0, shown);

  return (
    <div className="page desk port-page">
      <PageHead
        kicker="Market"
        title="Explore"
        lede="Pokoin catalog in PKN. Art from cdn.pokoin.com."
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
            ? 'Loading listings…'
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
            placeholder="Search listings…"
            aria-label="Search listings"
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
              Saved ids only
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
            <span className="filter-label">Price (PKN)</span>
            <div className="explore-price">
              <input type="number" min="0" step="1" placeholder="Min" value={min} onChange={(event) => setMin(event.target.value)} />
              <span>to</span>
              <input type="number" min="0" step="1" placeholder="Max" value={max} onChange={(event) => setMax(event.target.value)} />
            </div>
          </div>
          {langNames.length ? (
            <div className="filter-group">
              <span className="filter-label">Language</span>
              {langNames.map((lang) => (
                <label className="filter-option" key={lang}>
                  <input type="checkbox" checked={langs.has(lang)} onChange={() => toggleSet(setLangs, lang)} />
                  {lang}
                </label>
              ))}
            </div>
          ) : null}
        </aside>
        <section>
          {catalog && !filtered.length ? (
            <EmptyDesk title="No listings match" lede="Clear filters, or list a card from a card desk." />
          ) : (
            <div className="explore-grid">
              {visible.map((item) => (
                <article className="explore-card" key={item.id}>
                  <Link to={`/marketplace/portfolio/${item.id}`}>
                    <CardArt src={imageSrc(item, 'hero')} alt="" loading="lazy" />
                    <strong>{item.name}</strong>
                    <span className="muted">{[item.expansion, item.number].filter(Boolean).join(' · ')}</span>
                    <span className="muted">{item.condition || (item.sealed ? 'Sealed' : '—')}{item.qty > 1 ? ` · ×${item.qty}` : ''}</span>
                    <em>{money(item.pricePkn)}</em>
                  </Link>
                  <button
                    className={dumpWatchedAt(item.id, watchTick) ? 'explore-add on' : 'explore-add'}
                    type="button"
                    aria-label="Save id"
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
