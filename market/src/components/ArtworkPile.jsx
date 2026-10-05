import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { isFeatureAlbumArt, isLandscapePrintName, resolveArtLayout } from '../art-cut.js';
import { albumShadeStyle } from '../art-shade.js';
import { cardHref, formatPkn, imageSrc, rememberCardId } from '../api.js';
import { printingIdentity } from '../identity.js';
import { tilePricePkn } from '../pkn.js';
import { cardImageAlt } from '../seo.js';
import { Action, track } from '../track.js';
import { groupArtworkRows, pileCardTier } from '../search-filters.js';
import { useCardSelect } from './CardSelectGrid.jsx';
import CardArt from './CardArt.jsx';

export { groupArtworkRows };

/** Artist album tile for a same-artwork group: stacked sheets + count chip. */
export function ArtistPileTile({ group, rank, onOpen }) {
  const rep = group.cards[0];
  const select = useCardSelect();
  const picked = Boolean(select?.selected?.has(String(rep.id)));
  if (!rep?.id) {
    return null;
  }
  const identity = printingIdentity(rep);
  const landscape = isLandscapePrintName(rep.name);
  const artLayout = resolveArtLayout(rep);
  const item = artLayout === 'item';
  const tall = !landscape && isFeatureAlbumArt(rep);
  const hero = imageSrc(rep, 'hero');

  function prefetch() {
    if (hero) {
      const img = new Image();
      img.src = hero;
    }
  }

  function onTileClick(event) {
    // Shift/ctrl/meta extend the band selection like CardTile; plain click
    // opens the same-artwork overlay.
    if (select && (event.metaKey || event.ctrlKey || event.shiftKey)) {
      event.preventDefault();
      select.click(rep.id, event);
      return;
    }
    event.preventDefault();
    onOpen(group);
  }

  return (
    <div className={`tile-pile-wrap${tall ? " tile-pile-tall" : ""}`}>
      <span className="tile-pile-sheet s2" aria-hidden="true" />
      <span className="tile-pile-sheet s1" aria-hidden="true" />
      <Link
        className={[
          'tile',
          'tile-cut tile-album',
          tall ? 'tile-tall' : '',
          item ? 'tile-item' : '',
          landscape ? 'is-landscape' : '',
          picked ? 'is-selected' : '',
        ].filter(Boolean).join(' ')}
        to={cardHref(rep)}
        state={{ card: rep }}
        data-card-id={rep.id}
        aria-selected={picked || undefined}
        aria-label={`${rep.name}, ${group.cards.length} printings of the same artwork`}
        onClick={onTileClick}
        onPointerEnter={prefetch}
        style={albumShadeStyle(rep)}
      >
        <span className="tile-art">
          {hero ? (
            <CardArt
              src={hero}
              alt={cardImageAlt(rep)}
              cut={!landscape && !item}
              cutSurface="album"
              full
              card={rep}
              loading={rank != null && rank < 8 ? 'eager' : 'lazy'}
              fetchPriority={rank != null && rank < 4 ? 'high' : undefined}
            />
          ) : <span className="tile-ph" />}
        </span>
        <span className="tile-pile-count" aria-hidden="true">×{group.cards.length}</span>
        <div className="tile-meta">
          {identity.tileLine ? <em className="tile-id">{identity.tileLine}</em> : null}
        </div>
      </Link>
    </div>
  );
}

/**
 * Popup over an artist pile: every printing of the artwork as a full card,
 * each linking to its card desk. Esc / backdrop click / ✕ close it.
 */
export function ArtworkPileOverlay({ group, artistName, onClose }) {
  const closeRef = useRef(null);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const rep = group.cards[0];
  // Normal printing first, then Poké Ball, then Master Ball, then the rest —
  // stable within tiers so the desk order holds.
  const orderedCards = [...group.cards].sort((a, b) => pileCardTier(a) - pileCardTier(b));

  return (
    <div className="artwork-pile-backdrop" onClick={onClose}>
      <div
        className="artwork-pile-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`${rep?.name || 'Artwork'} printings`}
      >
        <header className="artwork-pile-head">
          <div className="artwork-pile-title">
            <strong>{rep?.name || 'Same artwork'}</strong>
            <span>
              {group.cards.length} printings{artistName ? ` · ${artistName}` : ''}
            </span>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="artwork-pile-close"
            onClick={onClose}
            aria-label="Close"
          >
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="artwork-pile-row">
          {orderedCards.map((card, index) => {
            const price = formatPkn(tilePricePkn(card));
            const identity = printingIdentity(card);
            return (
              <div
                className="artwork-pile-card"
                key={card.id || card.card_id || index}
                style={{ '--pile-i': index, '--pile-tilt': index % 2 ? '2.4deg' : '-2.4deg' }}
                onClick={(event) => event.stopPropagation()}
              >
                <Link
                  className="artwork-pile-frame"
                  to={cardHref(card)}
                  state={{ card }}
                  onClick={() => {
                    rememberCardId(card);
                    track(Action.clickTile, card, { resultRank: index });
                    onClose();
                  }}
                >
                  <CardArt
                    src={imageSrc(card, 'hero')}
                    alt={cardImageAlt(card)}
                    full
                    card={card}
                    loading={index < 6 ? 'eager' : 'lazy'}
                  />
                </Link>
                {identity.tileLine ? <em className="artwork-pile-line">{identity.tileLine}</em> : null}
                {price ? <span className="artwork-pile-price">{price}</span> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
