import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  cardHref,
  catalogFromScanHit,
  identifyScan,
  publicIdFromScanHit,
  scanHitsOf,
} from '../api.js';

export default function Scan() {
  const navigate = useNavigate();
  const [preview, setPreview] = useState('');
  const [query, setQuery] = useState('');
  const [file, setFile] = useState(null);
  const [hits, setHits] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = 'Scan · Pokoin';
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  function onFile(event) {
    const next = event.target.files?.[0];
    if (!next) return;
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(next));
    setFile(next);
    setHits([]);
    setError('');
    const stem = next.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    setQuery(stem);
  }

  async function identify(event) {
    event.preventDefault();
    if (!file) {
      search();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = await identifyScan(file);
      const raw = scanHitsOf(data);
      const resolved = [];
      for (const hit of raw) {
        const card = await catalogFromScanHit(hit);
        resolved.push({
          hit,
          card,
          publicId: publicIdFromScanHit(hit),
          name: hit.name || hit.card_name || card?.name || 'Unknown',
          set: hit.set || hit.set_name || card?.set || '',
          number: hit.collector_number || hit.number || card?.number || '',
        });
      }
      setHits(resolved);
      if (!resolved.length) {
        setError('No OCR match. Search the catalog below — Scan Fast ids are TCGplayer, never public card_id.');
      }
    } catch (err) {
      setError(err.message || 'Scan identify failed.');
      setHits([]);
    } finally {
      setBusy(false);
    }
  }

  function search(event) {
    event?.preventDefault?.();
    const next = query.trim();
    navigate(next ? `/marketplace/search?q=${encodeURIComponent(next)}` : '/marketplace/search');
  }

  return (
    <div className="page app-page">
      <div className="comp-head">
        <div>
          <p className="eyebrow">Identify</p>
          <h1>Card scan</h1>
          <p className="muted">Photo posts to /cardscan/identify. Public card_id is CardTrader blueprint × 2. TCGplayer ids are ignored.</p>
        </div>
      </div>
      <form className="panel auth-card" onSubmit={identify}>
        <label className="sell-field">
          Photo
          <input type="file" accept="image/*" capture="environment" onChange={onFile} />
        </label>
        {preview ? <img className="scan-preview" src={preview} alt="Selected card" /> : null}
        <label className="sell-field">
          Search catalog
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Card name" />
        </label>
        {error ? <p className="status error">{error}</p> : null}
        <div className="actions">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Identifying…' : (file ? 'Identify photo' : 'Search marketplace')}
          </button>
          <button className="btn ghost" type="button" onClick={search}>Search catalog</button>
        </div>
      </form>
      {hits.length ? (
        <div className="forum-list">
          {hits.map((row, index) => {
            const href = row.card ? cardHref(row.card) : (row.publicId ? `/marketplace/en/cards/${row.publicId}` : '');
            return href ? (
              <Link className="forum-row" key={`${row.publicId || row.name}-${index}`} to={href}>
                <strong>{row.name}</strong>
                <span className="muted">{[row.set, row.number].filter(Boolean).join(' · ') || 'Matched printing'}</span>
              </Link>
            ) : (
              <article className="forum-row" key={`${row.name}-${index}`}>
                <strong>{row.name}</strong>
                <span className="muted">No catalog match. TCGplayer id ignored.</span>
              </article>
            );
          })}
        </div>
      ) : null}
      <p className="muted"><Link to="/marketplace">Open the shop</Link> without a photo.</p>
    </div>
  );
}
