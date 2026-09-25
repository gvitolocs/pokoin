import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchCardTiles, imageSrc } from '../api.js';
import { chatImageSources, isSellerCard, tagKey } from '../chat-listing.js';
import ThumbZoom from './ThumbZoom.jsx';

export default function ChatListingTag({ row, onRemove }) {
  const label = row.cardName || 'Card';
  const sources = chatImageSources(row);
  const [step, setStep] = useState(0);
  const [extra, setExtra] = useState('');
  const identity = `${row.imageUrl || ''}|${row.cardId || ''}`;

  useEffect(() => {
    setStep(0);
    setExtra('');
  }, [identity]);

  useEffect(() => {
    const id = String(row.cardId || '').trim();
    if (!id || sources.length) return undefined;
    let live = true;
    fetchCardTiles([id]).then((tiles) => {
      const card = (tiles || []).find((item) => String(item?.id) === id) || tiles?.[0];
      const next = imageSrc(card, 'grid') || imageSrc(card, 'hero');
      if (live && next) setExtra(next);
    }).catch(() => {});
    return () => { live = false; };
  }, [identity, sources.length, row.cardId]);

  const list = extra && !sources.includes(extra) ? [...sources, extra] : sources;
  const src = list[Math.min(step, Math.max(list.length - 1, 0))] || '';
  const full = sources[sources.length - 1] || extra || src;

  function onError() {
    if (step + 1 < list.length) {
      setStep(step + 1);
      return;
    }
    const id = String(row.cardId || '').trim();
    if (!id || extra) return;
    fetchCardTiles([id]).then((tiles) => {
      const card = (tiles || []).find((item) => String(item?.id) === id) || tiles?.[0];
      const next = imageSrc(card, 'grid') || imageSrc(card, 'hero');
      if (next) setExtra(next);
    }).catch(() => {});
  }

  const image = src ? (
    <ThumbZoom src={full} full alt={label}>
      <img src={src} alt="" onError={onError} />
    </ThumbZoom>
  ) : <span className="chat-tag-ph" />;
  return (
    <span className={`chat-tag${isSellerCard(row) ? '' : ' is-trade'}`}>
      {row.path ? (
        <Link to={row.path} aria-label={label} onClick={(event) => event.stopPropagation()}>{image}</Link>
      ) : (
        <span className="chat-tag-body" role="img" aria-label={label}>{image}</span>
      )}
      {onRemove ? (
        <button type="button" aria-label={`Remove ${label}`} onClick={() => onRemove(tagKey(row))}>×</button>
      ) : null}
    </span>
  );
}
