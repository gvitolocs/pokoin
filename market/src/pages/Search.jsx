import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchSearch } from '../api.js';
import { Action, track } from '../track.js';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';

export default function Search() {
  const [params] = useSearchParams();
  const query = (params.get('q') || params.get('query') || '').trim();
  const [cards, setCards] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title = query ? `${query} · Pokoin` : 'Search · Pokoin';
    let cancelled = false;
    setLoading(true);
    fetchSearch({ query, offset: 0, limit: 48 })
      .then((data) => {
        if (cancelled) {
          return;
        }
        const next = data.cards || [];
        setCards(next);
        setHasMore(Boolean(data.hasMore));
        setError('');
        if (next[0]) {
          track(Action.searchSubmit, next[0], { query, resultCount: next.length });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Search failed.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  async function loadMore() {
    const data = await fetchSearch({ query, offset: cards.length, limit: 48 });
    const extra = data.cards || [];
    setCards((current) => [...current, ...extra]);
    setHasMore(Boolean(data.hasMore));
    if (extra[0]) {
      track(Action.loadMore, extra[0], { query, resultCount: cards.length + extra.length });
    }
  }

  return (
    <div className="page" aria-busy={loading ? 'true' : undefined}>
      <h1>{query || 'Search'}</h1>
      {!loading && !error ? (
        <p className="muted">{cards.length ? `${cards.length}${hasMore ? '+' : ''} results` : 'No cards match that search.'}</p>
      ) : (
        <p className="muted">{'\u00a0'}</p>
      )}
      {error ? <p className="status error">{error}</p> : null}
      <div className="grid">
        {loading
          ? Array.from({ length: 24 }, (_, index) => <SkeletonTile key={index} />)
          : cards.map((card, index) => (
              <CardTile key={card.id} card={card} rank={index} />
            ))}
      </div>
      {hasMore ? (
        <button className="more" type="button" onClick={loadMore}>Load more</button>
      ) : null}
    </div>
  );
}
