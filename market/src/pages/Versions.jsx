import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { cardFromCatalogRow, cardHref, fetchCard } from '../api.js';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';

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
    <div className="page desk">
      <nav className="crumbs">
        <Link to="/marketplace">Marketplace</Link>
        <span>/</span>
        {card ? <Link to={cardHref(card)}>{card.name}</Link> : <span>{slug || cardId}</span>}
        <span>/</span>
        <span>Versions</span>
      </nav>
      <PageHead
        kicker="Printings"
        title={card?.name || 'Versions'}
        lede="From marketplace-card-page.versions. The timed-out marketplace-card-versions endpoint is not used."
      />
      <div className="shop-toolbar">
        <p className="result-count">
          {payload ? <><strong>{rows.length}</strong> printings</> : 'Loading…'}
        </p>
      </div>
      <Alert>{error}</Alert>
      {payload && !rows.length ? (
        <EmptyDesk title="No other printings" lede="This page response has a single version." />
      ) : (
        <div className="grid">
          {!payload && !error
            ? Array.from({ length: 8 }, (_, index) => <SkeletonTile key={index} />)
            : rows.map((row, index) => (
                <CardTile key={row.id} card={row} rank={index} />
              ))}
        </div>
      )}
    </div>
  );
}
