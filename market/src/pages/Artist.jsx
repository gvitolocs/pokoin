import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchArtist, fetchArtistSummaries } from '../api.js';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import { Alert, DeskPanel, EmptyDesk, PageHead } from '../components/Desk.jsx';

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
    <div className="page desk">
      <PageHead kicker="Catalog" title="Artists" lede="Illustrators from marketplace-artist summaries." />
      <Alert>{error}</Alert>
      {artists == null && !error ? <p className="page-lede">Loading artists…</p> : null}
      {artists && !artists.length ? (
        <EmptyDesk title="No artist summaries" lede="Open an artist from a card page." />
      ) : (
        <DeskPanel flush>
          <div className="set-index">
            {(artists || []).map((row) => {
              const slug = row.slug || row.artistSlug;
              const name = row.name || row.artist || slug;
              if (!slug) return null;
              return (
                <Link className="set-index-row" key={slug} to={`/marketplace/en/artists/${slug}`}>
                  <span className="set-sym" />
                  <strong>{name}</strong>
                  <span className="muted">{row.count || row.cardCount || ''}</span>
                </Link>
              );
            })}
          </div>
        </DeskPanel>
      )}
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
    <div className="page desk">
      <nav className="crumbs">
        <Link to={`/marketplace/${lang}/artists`}>Artists</Link>
        <span>/</span>
        <span>{name}</span>
      </nav>
      <PageHead kicker="Artist" title={name} lede="Printings attributed to this illustrator." />
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
      <div className="shop-toolbar">
        <p className="result-count">
          {payload
            ? (cards.length ? <><strong>{cards.length}</strong> cards</> : 'No cards for this artist from the API.')
            : 'Loading…'}
        </p>
      </div>
      <Alert>{error}</Alert>
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
