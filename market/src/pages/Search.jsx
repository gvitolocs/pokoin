import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchSearch } from '../api.js';
import { Action, track } from '../track.js';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';

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
    <div className="page desk" aria-busy={loading ? 'true' : undefined}>
      <PageHead
        kicker="Catalog"
        title={query || 'Search'}
        lede={query ? `Matches for “${query}”. Use the bar above to refine.` : 'Search a card, set, or product from the bar above.'}
      >
        <Link className="btn ghost" to="/marketplace">Shop</Link>
      </PageHead>
      <div className="shop-toolbar">
        <p className="result-count">
          {loading
            ? 'Searching…'
            : (cards.length
              ? <><strong>{cards.length.toLocaleString('en-US')}{hasMore ? '+' : ''}</strong> results</>
              : 'No cards match that search.')}
        </p>
      </div>
      <Alert>{error}</Alert>
      {!loading && !cards.length && !error ? (
        <EmptyDesk title="No matches" lede="Try a collector number, a set name, or a shorter card name.">
          <Link className="btn" to="/marketplace">Browse marketplace</Link>
        </EmptyDesk>
      ) : (
        <div className="grid">
          {loading
            ? Array.from({ length: 24 }, (_, index) => <SkeletonTile key={index} />)
            : cards.map((card, index) => (
                <CardTile key={card.id} card={card} rank={index} />
              ))}
        </div>
      )}
      {hasMore ? (
        <button className="more" type="button" onClick={loadMore}>Load more</button>
      ) : null}
    </div>
  );
}
