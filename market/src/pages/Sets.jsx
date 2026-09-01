import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchExpansions, setSlug } from '../api.js';
import CardArt from '../components/CardArt.jsx';

export default function Sets() {
  const [expansions, setExpansions] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    document.title = 'Sets · Pokoin';
    let cancelled = false;
    fetchExpansions({ limit: 80 })
      .then((data) => {
        if (!cancelled) setExpansions(data.expansions || data.sets || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Sets failed.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = (expansions || []).filter((row) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${row.name || ''} ${row.slug || ''}`.toLowerCase().includes(needle);
  });

  return (
    <div className="page">
      <p className="eyebrow">Catalog</p>
      <h1>Sets</h1>
      <form className="comp-toolbar" onSubmit={(event) => event.preventDefault()}>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter sets…"
          aria-label="Filter sets"
        />
      </form>
      {error ? <p className="status error">{error}</p> : null}
      {expansions == null && !error ? <p className="muted">Loading sets…</p> : null}
      <div className="set-index">
        {rows.map((row) => {
          const slug = row.slug || setSlug(row.name);
          const symbol = row.defaultSymbolUrl || row.symbolImageUrl || row.symbol || '';
          return (
            <Link className="set-index-row" key={slug || row.name} to={`/marketplace/sets/${slug}`}>
              {symbol ? <CardArt className="set-sym" src={symbol} alt="" fallback="hide" /> : <span className="set-sym" />}
              <strong>{row.name}</strong>
              <span className="muted">{row.cardCount || row.count || row.cards || ''}</span>
            </Link>
          );
        })}
      </div>
      {expansions && !rows.length ? <p className="muted">No sets match that filter.</p> : null}
    </div>
  );
}
