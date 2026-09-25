import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchListings, imageSrc } from '../api.js';
import { fetchCardTiles } from '../lists.js';
import {
  cardIdOf,
  chatImageSources,
  isSellerCard,
  personListsCard,
  tagKey,
} from '../chat-listing.js';
import ThumbZoom from './ThumbZoom.jsx';

function unique(list) {
  const out = [];
  for (const item of list) {
    const value = String(item || '').trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

export default function ChatListingTag({ row, onRemove, peer, me }) {
  const label = row.cardName || 'Card';
  const id = cardIdOf(row);
  const identity = `${row.imageUrl || ''}|${id}|${row.sellerUid || ''}|${row.seller || ''}`;
  const peerUid = peer?.uid || '';
  const peerName = peer?.username || '';
  const meUid = me?.uid || '';
  const meName = me?.username || '';
  const [step, setStep] = useState(0);
  const [catalog, setCatalog] = useState([]);
  const [failed, setFailed] = useState(false);
  const [painted, setPainted] = useState(false);
  const [owned, setOwned] = useState(() => (isSellerCard(row) ? 'yes' : (id ? 'pending' : 'no')));

  useEffect(() => {
    setStep(0);
    setCatalog([]);
    setFailed(false);
    setPainted(false);
    setOwned(isSellerCard(row) ? 'yes' : (id ? 'pending' : 'no'));
  }, [identity, id, row.seller, row.sellerUid, row.imageUrl]);

  useEffect(() => {
    if (!id) return undefined;
    let live = true;
    const people = [
      { uid: peerUid, username: peerName },
      { uid: meUid, username: meName },
    ];
    fetchCardTiles([id]).then((tiles) => {
      const card = (tiles || []).find((item) => String(item?.id) === id) || tiles?.[0];
      const next = unique([imageSrc(card, 'grid'), imageSrc(card, 'hero')]);
      if (live && next.length) setCatalog(next);
    }).catch(() => {});
    if (!isSellerCard(row)) {
      fetchListings(id).then((data) => {
        if (!live) return;
        setOwned(personListsCard(data?.listings, people) ? 'yes' : 'no');
      }).catch(() => {
        if (live) setOwned('no');
      });
    }
    return () => { live = false; };
  }, [id, identity, peerUid, peerName, meUid, meName, row.seller, row.sellerUid, row.imageUrl]);

  const list = unique([...chatImageSources(row), ...catalog]);
  const catalogKey = catalog.join('|');
  useEffect(() => {
    if (!catalogKey) return;
    const at = list.findIndex((item) => catalog.includes(item));
    if (at < 0) return;
    if ((!painted || failed) && step !== at) setStep(at);
  }, [catalogKey, painted, failed, step, list, catalog]);

  const src = list[Math.min(step, Math.max(list.length - 1, 0))] || '';
  const full = catalog[catalog.length - 1] || list[list.length - 1] || src;

  function onError() {
    if (step + 1 < list.length) setStep(step + 1);
    else setFailed(true);
  }

  const image = src ? (
    <ThumbZoom src={full} full alt={label}>
      <img
        src={src}
        alt=""
        onError={onError}
        onLoad={(event) => {
          const img = event.currentTarget;
          if (img.naturalWidth > 0 && img.naturalWidth < 24) onError();
          else setPainted(true);
        }}
      />
    </ThumbZoom>
  ) : <span className="chat-tag-ph" />;
  const trade = owned === 'no';
  return (
    <span className={`chat-tag${trade ? ' is-trade' : ''}`}>
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
