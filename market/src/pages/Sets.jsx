import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchExpansions, setSlug } from '../api.js';
import CardArt from '../components/CardArt.jsx';
import { Alert, DeskPanel, EmptyDesk, PageHead } from '../components/Desk.jsx';

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
    <div className="page desk">
      <PageHead kicker="Catalog" title="Sets" lede="Pokémon expansions from the marketplace catalog." />
      <form className="shop-toolbar" onSubmit={(event) => event.preventDefault()}>
        <p className="result-count">
          {expansions == null ? 'Loading…' : <><strong>{rows.length}</strong> sets</>}
        </p>
        <input
          className="shop-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter sets…"
          aria-label="Filter sets"
        />
      </form>
      <Alert>{error}</Alert>
      {expansions && !rows.length ? (
        <EmptyDesk title="No sets match" lede="Clear the filter or open a set from a card desk." />
      ) : (
        <DeskPanel flush>
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
        </DeskPanel>
      )}
    </div>
  );
}
