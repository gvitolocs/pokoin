import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { clearWatchlist, hydrateWatchlist } from '../api.js';
import CardTile from '../components/CardTile.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';

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
    <div className="page desk">
      <PageHead kicker="Account" title="Watchlist" lede="Saved on this browser until you sign in. Not a server list.">
        {cards?.length ? (
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              clearWatchlist();
              setCards([]);
            }}
          >
            Clear
          </button>
        ) : null}
        <Link className="btn ghost" to="/marketplace">Shop</Link>
      </PageHead>
      <Alert>{error}</Alert>
      {cards == null ? <div className="skeleton-line" /> : null}
      {cards && !cards.length ? (
        <EmptyDesk title="Nothing watched" lede="Open a card and tap the star.">
          <Link className="btn" to="/marketplace">Browse marketplace</Link>
        </EmptyDesk>
      ) : null}
      <div className="grid">
        {(cards || []).map((card, index) => (
          <CardTile key={card.id} card={card} rank={index} />
        ))}
      </div>
    </div>
  );
}
