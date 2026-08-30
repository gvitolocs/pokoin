import { Link } from 'react-router-dom';
import { cardHref, formatPkn, imageSrc, rememberCardId } from '../api.js';
import { printingIdentity } from '../identity.js';
import { Action, track } from '../track.js';

export default function CardTile({ card, action = Action.clickTile, rank }) {
  if (!card?.id) {
    return null;
  }
  const href = cardHref(card);
  const identity = printingIdentity(card);
  const price = formatPkn(card.price);
  const available = card.isMarketAvailable === true || card.inStock === true;
  const art = imageSrc(card, 'grid');
  const hero = imageSrc(card, 'hero');

  function onClick() {
    rememberCardId(card.id);
    track(action, card, { resultRank: rank });
  }

  function prefetch() {
    if (hero) {
      const img = new Image();
      img.src = hero;
    }
  }

  return (
    <Link className="tile" to={href} state={{ card }} onClick={onClick} onPointerEnter={prefetch}>
      <span className="tile-art">
        {art ? <img src={art} alt="" loading="lazy" /> : <span className="tile-ph" />}
      </span>
      <div className="tile-meta">
        <strong>{card.name}</strong>
        <span className="muted">{identity.tileLine}</span>
        <span className={available && price ? 'price' : 'oos'}>
          {available && price ? price : 'Out of stock'}
        </span>
      </div>
    </Link>
  );
}
