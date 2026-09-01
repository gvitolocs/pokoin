import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { clearWatchlist, hydrateWatchlist } from '../api.js';
import CardTile from '../components/CardTile.jsx';

export default function Watchlist() {
  const [cards, setCards] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = 'Watchlist · Pokoin';
    let cancelled = false;
    hydrateWatchlist()
      .then((rows) => {
        if (!cancelled) setCards(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Watchlist failed.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="page">
      <div className="comp-head">
        <div>
          <p className="eyebrow">Account</p>
          <h1>Watchlist</h1>
          <p className="muted">Saved on this browser until you sign in.</p>
        </div>
        {cards?.length ? (
          <button
            className="more"
            type="button"
            style={{ margin: 0 }}
            onClick={() => {
              clearWatchlist();
              setCards([]);
            }}
          >
            Clear
          </button>
        ) : null}
      </div>
      {error ? <p className="status error">{error}</p> : null}
      {cards == null ? <p className="muted">Loading watchlist…</p> : null}
      {cards && !cards.length ? (
        <p className="muted">
          Nothing watched yet. Open a card and tap the star, or browse the
          {' '}
          <Link to="/marketplace">marketplace</Link>.
        </p>
      ) : null}
      <div className="grid">
        {(cards || []).map((card, index) => (
          <CardTile key={card.id} card={card} rank={index} />
        ))}
      </div>
    </div>
  );
}
