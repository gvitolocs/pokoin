import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchCard, fetchListings, imageSrc } from '../api.js';
import { fetchCardTiles } from '../lists.js';
import {
  cardIdOf,
  chatImageSources,
  isSellerCard,
  listingQty,
  listingStock,
  paintOwned,
  personListsCard,
  tagKey,
  writeCardOwned,
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

function urlsFromCard(card) {
  if (!card) return [];
  return unique([
    card.homepageImageUrl,
    card.tileImageUrl,
    card.homepage_image_url,
    card.heroImageUrl,
    card.imageUrl,
    card.gridImageUrl,
    card.image_url,
    imageSrc(card, 'grid'),
    imageSrc(card, 'hero'),
  ]);
}

/** Tiles miss some printings (Ancient Origins Meowth 219916). The card page still has the scan. */
async function loadCatalogImages(id) {
  const tiles = await fetchCardTiles([id]).catch(() => []);
  const tile = (tiles || []).find((item) => String(item?.id) === id) || tiles?.[0];
  const fromTiles = urlsFromCard(tile);
  if (fromTiles.length) return fromTiles;
  const page = await fetchCard(id).catch(() => null);
  return urlsFromCard(page?.card);
}

function stopControl(event) {
  event.preventDefault();
  event.stopPropagation();
}

function CardQuantity({ row, draft, onQty }) {
  const qty = listingQty(row?.qty, row?.stock);
  const cap = listingStock(row?.stock);
  if (!draft) {
    if (row?.qty == null || row.qty === '') return null;
    return <span className="chat-qty-badge">{listingQty(row.qty, 99)}</span>;
  }
  return (
    <span className="chat-qty" onClick={stopControl} onPointerDown={stopControl}>
      <button type="button" aria-label="Decrease quantity" disabled={qty <= 1} onClick={(event) => { stopControl(event); onQty?.(tagKey(row), qty - 1); }}>−</button>
      <b>{qty}</b>
      <button type="button" aria-label="Increase quantity" disabled={qty >= cap} onClick={(event) => { stopControl(event); onQty?.(tagKey(row), qty + 1); }}>+</button>
    </span>
  );
}

export default function ChatListingTag({ row, onRemove, onQty, peer, me }) {
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
  const people = [
    { uid: peerUid, username: peerName },
    { uid: meUid, username: meName },
  ];
  const [owned, setOwned] = useState(() => paintOwned(row, id, people));

  useEffect(() => {
    setStep(0);
    setCatalog([]);
    setFailed(false);
    setPainted(false);
    setOwned(paintOwned(row, id, people));
  }, [identity, id, row.seller, row.sellerUid, row.imageUrl, peerUid, peerName, meUid, meName]);

  useEffect(() => {
    if (!id) return undefined;
    let live = true;
    const people = [
      { uid: peerUid, username: peerName },
      { uid: meUid, username: meName },
    ];
    loadCatalogImages(id).then((next) => {
      if (live && next.length) setCatalog(next);
    }).catch(() => {});
    if (!isSellerCard(row)) {
      fetchListings(id).then((data) => {
        if (!live) return;
        const next = personListsCard(data?.listings, people) ? 'yes' : 'no';
        writeCardOwned(id, people, next);
        setOwned(next);
      }).catch(() => {});
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
  const full = list.find((url) => /\.jpe?g(?:\?|$)/i.test(url)) || list[list.length - 1] || src;

  function onError() {
    if (step + 1 < list.length) setStep(step + 1);
    else setFailed(true);
  }

  const draft = Boolean(onRemove);
  const quantity = <CardQuantity row={row} draft={draft} onQty={onQty} />;
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
      {quantity}
      {onRemove ? (
        <button type="button" aria-label={`Remove ${label}`} onClick={() => onRemove(tagKey(row))}>×</button>
      ) : null}
    </span>
  );
}
