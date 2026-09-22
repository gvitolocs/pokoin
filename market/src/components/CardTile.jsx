import { isLandscapePrintName, resolveArtLayout } from '../art-cut.js';
import { albumShadeStyle } from '../art-shade.js';
import { Link } from 'react-router-dom';
import { cardHref, formatPkn, imageSrc, rememberCardId } from '../api.js';
import { displayName, printingIdentity } from '../identity.js';
import { pokedexNumber } from '../pokedex.js';
import { tilePricePkn } from '../pkn.js';
import { cardImageAlt } from '../seo.js';
import { Action, track } from '../track.js';
import CardArt from './CardArt.jsx';

export default function CardTile({ card, action = Action.clickTile, rank, layout = 'grid', cut = false }) {
  if (!card?.id) {
    return null;
  }
  const href = cardHref(card);
  const price = formatPkn(tilePricePkn(card));
  const priceLabel = price || 'Out of stock';
  const identity = printingIdentity(card);
  const landscape = cut && isLandscapePrintName(card.name);
  const artLayout = cut ? resolveArtLayout(card) : 'window';
  const item = cut && artLayout === 'item';
  // Album grid keeps row order for Pokédex sort — no tall/dense packing.
  const tall = false;
  const albumDex = cut ? pokedexNumber(card) : 0;
  const hero = imageSrc(card, 'hero');
  const art = cut ? hero : imageSrc(card, layout === 'list' ? 'hero' : 'grid');
  const list = layout === 'list';

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
    <Link
      className={[
        list ? 'tile tile-row' : 'tile',
        cut ? 'tile-cut tile-album' : '',
        tall ? 'tile-tall' : '',
        item ? 'tile-item' : '',
        landscape ? 'is-landscape' : '',
      ].filter(Boolean).join(' ')}
      to={href}
      state={{ card }}
      onClick={onClick}
      onPointerEnter={prefetch}
      style={cut ? albumShadeStyle(card) : undefined}
    >
      <span className="tile-art">
        {art ? (
          <CardArt
            src={art}
            alt={cardImageAlt(card)}
            cut={cut && !landscape && !item}
            cutSurface="album"
            full={cut}
            card={cut ? card : undefined}
            loading={rank != null && rank < 8 ? 'eager' : 'lazy'}
            fetchPriority={rank != null && rank < 4 ? 'high' : undefined}
          />
        ) : <span className="tile-ph" />}
      </span>
      {cut ? (
        <div className="tile-meta">
          <strong>{displayName(card)}</strong>
          {albumDex > 0 ? <em className="tile-dex">#{String(albumDex).padStart(3, '0')}</em> : null}
          {identity.tileLine ? <em className="tile-id">{identity.tileLine}</em> : null}
        </div>
      ) : (
        <div className="tile-meta">
          <strong>{displayName(card)}</strong>
          {identity.tileLine ? <em className="tile-id">{identity.tileLine}</em> : null}
          {list ? null : (
            <span className={price ? 'price' : 'oos'}>
              {priceLabel}
            </span>
          )}
        </div>
      )}
      {list && !cut ? (
        <span className={price ? 'price' : 'oos'}>
          {priceLabel}
        </span>
      ) : null}
    </Link>
  );
}
