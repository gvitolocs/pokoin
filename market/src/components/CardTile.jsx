import { isFeatureAlbumArt, isLandscapePrintName, resolveArtLayout } from '../art-cut.js';
import { albumShadeStyle } from '../art-shade.js';
import { Link } from 'react-router-dom';
import { cardHref, formatPkn, imageSrc, rememberCardId } from '../api.js';
import { displayName, printingIdentity } from '../identity.js';
import { tilePricePkn } from '../pkn.js';
import { useBuyerCurrency } from '../use-buyer-currency.js';
import PriceStack from './PriceStack.jsx';
import { cardReference, cardsReference, writeListingDrag } from '../chat-listing.js';
import { useCardSelect } from './CardSelectGrid.jsx';
import { cardImageAlt } from '../seo.js';
import { Action, track } from '../track.js';
import ArtworkZoom from './ArtworkZoom.jsx';
import CardArt from './CardArt.jsx';

export default function CardTile({ card, action = Action.clickTile, rank, layout = 'grid', cut = false }) {
  const buyer = useBuyerCurrency();
  if (!card?.id) {
    return null;
  }
  const href = cardHref(card);
  const pricePkn = tilePricePkn(card);
  const price = formatPkn(pricePkn);
  // Unaffordable tiles show the local amount only. Affordable ones stay PKN.
  const priceLabel = price ? <PriceStack parts={buyer.parts(pricePkn)} /> : 'Out of stock';
  const identity = printingIdentity(card);
  const landscape = cut && isLandscapePrintName(card.name);
  const artLayout = cut ? resolveArtLayout(card) : 'window';
  const item = cut && artLayout === 'item';
  const tall = cut && !landscape && isFeatureAlbumArt(card);
  const hero = imageSrc(card, 'hero');
  const art = cut ? hero : imageSrc(card, layout === 'list' ? 'hero' : 'grid');
  const list = layout === 'list';
  const select = useCardSelect();
  const picked = Boolean(select?.selected?.has(String(card.id)));

  function onClick(event) {
    if (select && (event.metaKey || event.ctrlKey || event.shiftKey)) {
      event.preventDefault();
      select.click(card.id, event);
      return;
    }
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
        picked ? 'is-selected' : '',
      ].filter(Boolean).join(' ')}
      to={href}
      state={{ card }}
      data-card-id={card.id}
      aria-selected={picked || undefined}
      draggable
      onDragStart={(event) => {
        const mixed = select?.dragReference?.({ heldCard: card });
        if (mixed) {
          writeListingDrag(event, mixed);
          return;
        }
        const group = select?.cardsForDrag(card) || [card];
        writeListingDrag(event, group.length > 1 ? cardsReference(group) : cardReference(card));
      }}
      onClick={onClick}
      onPointerEnter={prefetch}
      style={cut ? albumShadeStyle(card) : undefined}
    >
      <span className="tile-art">
        {art && list ? (
          <ArtworkZoom
            src={hero || art}
            name={card.name}
            set={card.set || card.expansion || ''}
            alt={cardImageAlt(card)}
          />
        ) : art ? (
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
