import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { cardFromCatalogRow, cardHref, fetchCard } from '../api.js';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';

export default function Versions() {
  const { lang = 'en', cardId, slug } = useParams();
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = 'Versions · Pokoin';
    let cancelled = false;
    fetchCard(cardId, { lang })
      .then((data) => {
        if (cancelled) return;
        setPayload(data);
        const name = data?.card?.name || 'Card';
        document.title = `${name} versions · Pokoin`;
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Versions failed.');
      });
    return () => {
      cancelled = true;
    };
  }, [cardId, lang]);

  const card = payload?.card;
  const versions = (payload?.versions || []).map(cardFromCatalogRow).filter((row) => row.id);
  const rows = versions.length ? versions : (card ? [cardFromCatalogRow(card)] : []);

  return (
    <div className="page">
      <nav className="crumbs">
        <Link to="/marketplace">Marketplace</Link>
        <span>/</span>
        {card ? <Link to={cardHref(card)}>{card.name}</Link> : <span>{slug || cardId}</span>}
        <span>/</span>
        <span>Versions</span>
      </nav>
      <p className="eyebrow">Printings</p>
      <h1>{card?.name || 'Versions'}</h1>
      <p className="muted">
        From marketplace-card-page.versions. Do not use the timed-out marketplace-card-versions endpoint.
      </p>
      {error ? <p className="status error">{error}</p> : null}
      <div className="grid">
        {!payload && !error
          ? Array.from({ length: 8 }, (_, index) => <SkeletonTile key={index} />)
          : rows.map((row, index) => (
              <CardTile key={row.id} card={row} rank={index} />
            ))}
      </div>
      {payload && !rows.length ? <p className="muted">No other printings on this page response.</p> : null}
    </div>
  );
}
