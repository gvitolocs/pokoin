import { Link } from 'react-router-dom';
import { cardHref, formatPkn, imageSrc, rememberCardId } from '../api.js';
import { printingIdentity } from '../identity.js';
import { tilePricePkn } from '../pkn.js';
import { Action, track } from '../track.js';
import CardArt from './CardArt.jsx';

export default function CardTile({ card, action = Action.clickTile, rank }) {
  if (!card?.id) {
    return null;
  }
  const href = cardHref(card);
  const price = formatPkn(tilePricePkn(card));
  const identity = printingIdentity(card);
  const art = imageSrc(card, 'grid');
  const hero = imageSrc(card, 'hero');

  function onClick() {
    rememberCardId(card);
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
        {art ? (
          <CardArt
            src={art}
            alt=""
            loading={rank != null && rank < 8 ? 'eager' : 'lazy'}
            fetchPriority={rank != null && rank < 4 ? 'high' : undefined}
          />
        ) : <span className="tile-ph" />}
      </span>
      <div className="tile-meta">
        <strong>{card.name}</strong>
        {identity.tileLine ? <em className="tile-id">{identity.tileLine}</em> : null}
        <span className={price ? 'price' : 'oos'}>
          {price || '—'}
        </span>
      </div>
    </Link>
  );
}
