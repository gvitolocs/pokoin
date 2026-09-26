import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchArtist, fetchExpansionCards, fetchSellerShop, imageSrc } from '../api.js';
import { fetchSpeciesCards } from '../species-cards.js';
import { bundleOf, tagKey } from '../chat-listing.js';

function cardId(card) {
  return String(card?.id || card?.card_id || '');
}

function cardImage(card) {
  return card?.homepageImageUrl
    || card?.gridImageUrl
    || card?.imageUrl
    || card?.image_url
    || card?.cdn_image_url
    || imageSrc(card, 'grid')
    || '';
}

async function sellerCardIds(username) {
  const handle = String(username || '').trim();
  if (!handle) return new Set();
  const ids = new Set();
  let offset = 0;
  let total = Infinity;
  for (let page = 0; page < 20 && offset < total; page += 1) {
    const data = await fetchSellerShop(handle, { limit: 100, offset });
    total = Number(data?.total || 0);
    const rows = data?.listings || [];
    for (const row of rows) {
      const id = String(row?.cardId || row?.card_id || '');
      if (id) ids.add(id);
    }
    if (!rows.length) break;
    offset += rows.length;
  }
  return ids;
}

export default function ChatBundle({ row, peer, onRemove }) {
  const bundle = bundleOf(row);
  const [cards, setCards] = useState([]);
  const [listed, setListed] = useState(() => new Set());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!bundle?.slug) return undefined;
    let live = true;
    const cardsPromise = bundle.kind === 'artist'
      ? fetchArtist(bundle.slug, { limit: 240 }).then((data) => data?.cards || [])
      : bundle.kind === 'species'
        ? fetchSpeciesCards(bundle.slug)
        : fetchExpansionCards({ slug: bundle.slug }).then((data) => data?.cards || []);
    cardsPromise.then((rows) => {
      if (live) setCards(rows);
    }).catch(() => {});
    const handle = peer?.username || '';
    if (!handle) {
      setReady(true);
      return () => { live = false; };
    }
    sellerCardIds(handle).then((ids) => {
      if (!live) return;
      setListed(ids);
      setReady(true);
    }).catch(() => {
      if (live) setReady(true);
    });
    return () => { live = false; };
  }, [bundle?.kind, bundle?.slug, peer?.username]);

  if (!bundle) return null;
  const label = row?.cardName || (bundle.kind === 'artist' ? 'Artist' : bundle.kind === 'species' ? 'Pokémon' : 'Set');
  return (
    <span className="chat-bundle">
      <span className="chat-bundle-head">
        <strong>{label}</strong>
        {onRemove ? (
          <button type="button" aria-label={`Remove ${label}`} onClick={() => onRemove(tagKey(row))}>×</button>
        ) : null}
      </span>
      <span className="chat-bundle-grid" aria-label={`${label} cards`}>
        {cards.map((card) => {
          const id = cardId(card);
          const missing = ready && peer?.username && !listed.has(id);
          const src = cardImage(card);
          const href = card.canonicalPath || card.canonical_path || (id ? `/marketplace/en/cards/${id}` : row?.path || '/marketplace');
          return (
            <Link key={id || card.name} to={href} className={missing ? 'is-missing' : ''} title={card.name || ''}>
              {src ? <img src={src} alt="" /> : <span />}
            </Link>
          );
        })}
      </span>
    </span>
  );
}
