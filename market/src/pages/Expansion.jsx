import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchExpansion } from '../api.js';
import { Action, track } from '../track.js';
import CardTile from '../components/CardTile.jsx';

export default function Expansion() {
  const { slug } = useParams();
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPayload(null);
    fetchExpansion({ slug, limit: 48, offset: 0 })
      .then((data) => {
        if (cancelled) {
          return;
        }
        setPayload(data);
        document.title = `${data.expansion?.name || slug} · Pokoin`;
        setError('');
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Expansion failed.');
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
  }, [slug]);

  async function loadMore() {
    const data = await fetchExpansion({
      slug,
      expansionName: payload?.expansion?.name,
      limit: 48,
      offset: (payload?.cards || []).length,
    });
    const extra = data.cards || [];
    setPayload((current) => ({
      ...data,
      cards: [...(current?.cards || []), ...extra],
    }));
    if (extra[0]) {
      track(Action.loadMore, extra[0], { query: slug });
    }
  }

  const name = payload?.expansion?.name || slug;
  const cards = payload?.cards || [];
  const symbol = payload?.expansion?.defaultSymbolUrl || payload?.expansion?.symbolImageUrl;

  return (
    <div className="page">
      <nav className="crumbs">
        <Link to="/marketplace">Marketplace</Link>
        <span>/</span>
        <span>{name}</span>
      </nav>
      <div className="set-head">
        {symbol ? <img className="set-sym" src={symbol} alt="" /> : null}
        <div>
          <p className="eyebrow">Set</p>
          <h1>{loading && !payload ? 'Loading set…' : name}</h1>
          <p className="muted">{loading && !payload ? '' : `${cards.length}${payload?.hasMore ? '+' : ''} cards`}</p>
        </div>
      </div>
      {error ? <p className="status error">{error}</p> : null}
      {loading ? <p className="status">Loading set…</p> : null}
      <div className="grid">
        {cards.map((card, index) => (
          <CardTile key={card.id} card={card} rank={index} />
        ))}
      </div>
      {payload?.hasMore ? (
        <button className="more" type="button" onClick={loadMore}>Load more</button>
      ) : null}
    </div>
  );
}
