import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchArtist, fetchArtistSummaries } from '../api.js';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'illustration', label: 'Illustration' },
  { id: 'full-arts', label: 'Full arts' },
  { id: 'normal', label: 'Normal' },
];

function matchesFilter(card, filter) {
  const blob = `${card.rarity || ''} ${card.name || ''} ${card.productType || ''}`.toLowerCase();
  if (filter === 'illustration') return blob.includes('illustration');
  if (filter === 'full-arts') return blob.includes('full art') || blob.includes('full-art') || blob.includes('sir');
  if (filter === 'normal') return !blob.includes('illustration') && !blob.includes('full art');
  return true;
}

function ArtistsIndex() {
  const [artists, setArtists] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = 'Artists · Pokoin';
    let cancelled = false;
    fetchArtistSummaries({ limit: 80 })
      .then((data) => {
        if (!cancelled) setArtists(data.artists || data.summaries || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Artists failed.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="page">
      <p className="eyebrow">Catalog</p>
      <h1>Artists</h1>
      {error ? <p className="status error">{error}</p> : null}
      {artists == null && !error ? <p className="muted">Loading artists…</p> : null}
      {artists && !artists.length ? (
        <p className="muted">No artist summaries from the API right now. Open an artist from a card page.</p>
      ) : null}
      <div className="set-index">
        {(artists || []).map((row) => {
          const slug = row.slug || row.artistSlug;
          const name = row.name || row.artist || slug;
          if (!slug) return null;
          return (
            <Link className="set-index-row" key={slug} to={`/marketplace/en/artists/${slug}`}>
              <strong>{name}</strong>
              <span className="muted">{row.count || row.cardCount || ''}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function ArtistDesk() {
  const { lang = 'en', artistSlug } = useParams();
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    document.title = `${artistSlug} · Pokoin`;
    let cancelled = false;
    fetchArtist(artistSlug, { limit: 240 })
      .then((data) => {
        if (cancelled) return;
        setPayload(data);
        document.title = `${data.artist?.name || artistSlug} · Pokoin`;
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Artist failed.');
      });
    return () => {
      cancelled = true;
    };
  }, [artistSlug]);

  const cards = useMemo(() => (
    (payload?.cards || []).filter((card) => matchesFilter(card, filter))
  ), [payload, filter]);
  const name = payload?.artist?.name || payload?.name || artistSlug;

  return (
    <div className="page">
      <nav className="crumbs">
        <Link to={`/marketplace/${lang}/artists`}>Artists</Link>
        <span>/</span>
        <span>{name}</span>
      </nav>
      <p className="eyebrow">Artist</p>
      <h1>{name}</h1>
      <nav className="comp-tabs" aria-label="Artist filters">
        {FILTERS.map((row) => (
          <button
            key={row.id}
            type="button"
            className={filter === row.id ? 'on' : undefined}
            onClick={() => setFilter(row.id)}
          >
            {row.label}
          </button>
        ))}
      </nav>
      {error ? <p className="status error">{error}</p> : null}
      <p className="muted">
        {payload
          ? (cards.length ? `${cards.length} cards` : 'No cards for this artist from the API.')
          : 'Loading…'}
      </p>
      <div className="grid">
        {!payload && !error
          ? Array.from({ length: 12 }, (_, index) => <SkeletonTile key={index} />)
          : cards.map((card, index) => (
              <CardTile key={card.id} card={card} rank={index} />
            ))}
      </div>
    </div>
  );
}

export default function Artist() {
  const { artistSlug } = useParams();
  return artistSlug ? <ArtistDesk /> : <ArtistsIndex />;
}
