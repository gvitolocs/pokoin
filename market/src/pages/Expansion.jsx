import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchExpansion, peekExpansion, prettySlug } from '../api.js';
import { Action, track } from '../track.js';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';

export default function Expansion() {
  const { slug } = useParams();
  const [payload, setPayload] = useState(() => peekExpansion({ slug, limit: 48, offset: 0 }));
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const cached = peekExpansion({ slug, limit: 48, offset: 0 });
    setPayload(cached);
    fetchExpansion({ slug, limit: 48, offset: 0 })
      .then((data) => {
        if (cancelled) {
          return;
        }
        setPayload(data);
        document.title = `${data.expansion?.name || prettySlug(slug)} · Pokoin`;
        setError('');
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Expansion failed.');
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

  const loading = !payload && !error;
  const name = payload?.expansion?.name || prettySlug(slug);
  const cards = payload?.cards || [];
  const symbol = payload?.expansion?.defaultSymbolUrl || payload?.expansion?.symbolImageUrl;

  return (
    <div className="page" aria-busy={loading ? 'true' : undefined}>
      <nav className="crumbs">
        <Link to="/marketplace">Marketplace</Link>
        <span>/</span>
        <span>{name}</span>
      </nav>
      <div className="set-head">
        {symbol ? (
          <img className="set-sym" src={symbol} alt="" />
        ) : loading ? (
          <span className="set-sym skel-box" aria-hidden="true" />
        ) : null}
        <div>
          <p className="eyebrow">Set</p>
          <h1>{name}</h1>
          <p className="muted">{loading ? '\u00a0' : `${cards.length}${payload?.hasMore ? '+' : ''} cards`}</p>
        </div>
      </div>
      {error ? <p className="status error">{error}</p> : null}
      <div className="grid">
        {loading
          ? Array.from({ length: 24 }, (_, index) => <SkeletonTile key={index} />)
          : cards.map((card, index) => (
              <CardTile key={card.id} card={card} rank={index} />
            ))}
      </div>
      {payload?.hasMore ? (
        <button className="more" type="button" onClick={loadMore}>Load more</button>
      ) : null}
    </div>
  );
}
