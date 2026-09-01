import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  cardHref,
  catalogFromScanHit,
  identifyScan,
  publicIdFromScanHit,
  scanHitsOf,
} from '../api.js';
import { Alert, DeskPanel, FilePill, PageHead, Thread } from '../components/Desk.jsx';

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
    <div className="page desk">
      <PageHead
        kicker="Identify"
        title="Card scan"
        lede="Photo posts to /cardscan/identify. Public card_id is CardTrader blueprint × 2. TCGplayer ids are ignored."
      >
        <Link className="btn ghost" to="/marketplace">Shop</Link>
      </PageHead>
      <form onSubmit={identify}>
        <DeskPanel
          title="Photo or name"
          actions={(
            <>
              <button className="btn" type="submit" disabled={busy}>
                {busy ? 'Identifying…' : (file ? 'Identify photo' : 'Search marketplace')}
              </button>
              <button className="btn ghost" type="button" onClick={search}>Search catalog</button>
            </>
          )}
        >
          <div className="scan-stage">
            <div>
              {preview ? <img className="scan-preview" src={preview} alt="Selected card" /> : (
                <div className="empty-art" style={{ width: '100%', height: 220, borderRadius: 12 }}>No photo</div>
              )}
            </div>
            <div className="scan-fields">
              <FilePill accept="image/*" capture="environment" onChange={onFile}>
                {file ? file.name : 'Choose or capture a card'}
              </FilePill>
              <label className="sell-field">
                Search catalog
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Card name" />
              </label>
              <Alert>{error}</Alert>
            </div>
          </div>
        </DeskPanel>
      </form>
      {hits.length ? (
        <DeskPanel title="Matches">
          <div className="thread-list">
            {hits.map((row, index) => {
              const href = row.card ? cardHref(row.card) : (row.publicId ? `/marketplace/en/cards/${row.publicId}` : '');
              return href ? (
                <Thread
                  key={`${row.publicId || row.name}-${index}`}
                  to={href}
                  title={row.name}
                  meta={[row.set, row.number].filter(Boolean).join(' · ') || 'Matched printing'}
                />
              ) : (
                <article className="thread" key={`${row.name}-${index}`}>
                  <span className="thread-main">
                    <strong className="thread-title">{row.name}</strong>
                    <span className="thread-meta">No catalog match. TCGplayer id ignored.</span>
                  </span>
                </article>
              );
            })}
          </div>
        </DeskPanel>
      ) : null}
    </div>
  );
}
