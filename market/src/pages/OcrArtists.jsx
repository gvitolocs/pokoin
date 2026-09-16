import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import TestDock from '../components/TestDock.jsx';
import data from '../../public/review/western-artists.json';

export default function OcrArtists() {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(() => params.get('q') || '');

  useEffect(() => {
    document.title = 'Artists · Pokoin';
  }, []);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return data.artists;
    return data.artists.filter((row) => row.name.toLowerCase().includes(needle));
  }, [query]);

  const totals = data.totals;

  return (
    <div className="sanitize">
      <header className="sanitize-bar">
        <a className="brand" href="https://pokoin.com/" aria-label="Pokoin">
          <img src="/home/logo.png" alt="" width="40" height="40" />
          <span>Pokoin</span>
        </a>
        <p className="sanitize-host">
          pokoin.com · artists · {data.revision}
        </p>
      </header>

      <main className="sanitize-main ocr-main">
        <p className="sanitize-kicker">PP-OCRv5 Illus. · pokemontcg.io names</p>
        <h1>Pokémon card artists</h1>
        <p className="sanitize-lead">
          {totals.withArtist.toLocaleString('en-US')} of {totals.cards.toLocaleString('en-US')} western
          scans have an illustrator. Garbled OCR credits map to pokemontcg.io
          when they match. Flavor-text OCR is not an artist.
          Same CLIP artwork copies a real illustrator onto JP/CN reprints in the
          {' '}
          <Link className="linkish" to="/marketplace/en/artists">catalog artists</Link>
          {' '}
          grid.
        </p>
        <p className="sanitize-note">{data.rule}</p>

        <div className="ocr-filters">
          <p className="result-count">
            <strong>{shown.length}</strong> artists
            {shown.length !== totals.unique ? ` of ${totals.unique}` : ''}
          </p>
          <input
            type="search"
            value={query}
            onChange={(event) => {
              const next = event.target.value;
              setQuery(next);
              const trimmed = next.trim();
              const nextParams = new URLSearchParams(params);
              if (trimmed) nextParams.set('q', trimmed);
              else nextParams.delete('q');
              setParams(nextParams, { replace: true });
            }}
            placeholder="Filter artists…"
            aria-label="Filter artists"
          />
        </div>

        <div className="ocr-artist-wrap">
          <table className="ocr-artist-table">
            <thead>
              <tr>
                <th>Artist</th>
                <th>Cards</th>
                <th>Source</th>
                <th>Example cards</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.name}>
                  <td>
                    {row.matched ? (
                      <Link to={`/marketplace/en/artists/${row.slug}`}>{row.name}</Link>
                    ) : row.name}
                  </td>
                  <td>{row.count.toLocaleString('en-US')}</td>
                  <td>{row.matched ? 'pokemontcg.io' : 'OCR'}</td>
                  <td>
                    {row.cards.map((card, index) => (
                      <span key={`${card.ct_id}-${index}`}>
                        {index ? ' · ' : null}
                        <a href={`/marketplace/en/cards/${card.card_id}`}>
                          {card.name}
                        </a>
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
      <TestDock />
    </div>
  );
}
