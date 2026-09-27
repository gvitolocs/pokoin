import { useEffect, useMemo, useRef, useState } from 'react';
import { artCutVars } from '../art-cut.js';
import { artworkFigureMaskSrc } from '../art-figure-mask.js';
import { cardReference, writeListingDrag } from '../chat-listing.js';
import { rasterSiblings } from '../image-urls.js';
import { isCardTraderPlaceholderSize, MISSING_CARD_SRC } from '../missing-card.js';

function artDebugEnabled() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('pokoinDebugArt') === '1';
  } catch {
    return false;
  }
}

function logCardArt(event, detail) {
  if (typeof console === 'undefined' || typeof console.warn !== 'function') {
    return;
  }
  // Always surface desk/hero failures; verbose loads need localStorage.pokoinDebugArt=1.
  if (event !== 'error' && event !== 'dead' && event !== 'placeholder' && !artDebugEnabled()) {
    return;
  }
  console.warn('[pokoin:card-art]', event, detail);
}

export default function CardArt({
  src,
  alt = '',
  loading,
  fetchPriority,
  className,
  fallback = 'placeholder',
  full = false,
  cut = false,
  cutSurface,
  card,
  figureMask: figureMaskOverride,
  onClick,
  onLoad,
  onError,
  dragCard,
}) {
  const urls = useMemo(() => rasterSiblings(src, { full }), [src, full]);
  const [index, setIndex] = useState(0);
  const [dead, setDead] = useState(false);
  const imgRef = useRef(null);
  const errorSent = useRef(false);
  const indexRef = useRef(0);
  const urlsRef = useRef(urls);
  urlsRef.current = urls;
  indexRef.current = index;

  useEffect(() => {
    setIndex(0);
    indexRef.current = 0;
    setDead(false);
    errorSent.current = false;
  }, [src]);

  const current = urls[index] || '';
  const figureMask = figureMaskOverride
    ?? (cut && cutSurface === 'album' ? artworkFigureMaskSrc(card) : '');

  function failCurrent() {
    const failed = urlsRef.current[indexRef.current] || current || src;
    const next = indexRef.current + 1;
    if (next < urlsRef.current.length) {
      logCardArt('error', {
        full,
        cardId: card?.id || card?.card_id || '',
        failed,
        next: urlsRef.current[next],
        siblings: urlsRef.current,
      });
      indexRef.current = next;
      setIndex(next);
      return;
    }
    setDead(true);
    logCardArt('dead', {
      full,
      cardId: card?.id || card?.card_id || '',
      src,
      siblings: urlsRef.current,
    });
    if (!errorSent.current) {
      errorSent.current = true;
      onError?.();
    }
  }

  function acceptIfScan(img) {
    if (!img || !img.complete || img.naturalWidth <= 0) {
      return;
    }
    if (isCardTraderPlaceholderSize(img.naturalWidth, img.naturalHeight)) {
      logCardArt('placeholder', {
        full,
        cardId: card?.id || card?.card_id || '',
        src: img.currentSrc || current,
        natural: `${img.naturalWidth}x${img.naturalHeight}`,
      });
      failCurrent();
      return;
    }
    if (full) {
      logCardArt('load', {
        cardId: card?.id || card?.card_id || '',
        src: img.currentSrc || current,
        natural: `${img.naturalWidth}x${img.naturalHeight}`,
        siblings: urlsRef.current,
      });
    }
    onLoad?.();
  }

  useEffect(() => {
    acceptIfScan(imgRef.current);
  }, [current, onLoad]);

  useEffect(() => {
    if (urls.length || errorSent.current) {
      return;
    }
    errorSent.current = true;
    logCardArt('dead', {
      full,
      cardId: card?.id || card?.card_id || '',
      src,
      reason: 'empty-siblings',
    });
    onError?.();
  }, [urls.length, onError, full, card, src]);

  if (!current || dead) {
    if (fallback === 'hide') {
      return null;
    }
    const placeholder = (
      <img
        className={['missing-card', className].filter(Boolean).join(' ')}
        src={MISSING_CARD_SRC}
        alt={alt}
        width="630"
        height="880"
        onClick={onClick}
      />
    );
    if (cut) {
      return <span className="art-cut" style={artCutVars(card, cutSurface)}>{placeholder}</span>;
    }
    return placeholder;
  }

  const drag = dragCard ? {
    draggable: true,
    onDragStart: (event) => writeListingDrag(
      event,
      dragCard.kind && dragCard.cardName ? dragCard : cardReference(dragCard),
    ),
  } : {
    // Native <img> drag would paint a second ghost next to our pile.
    draggable: false,
  };
  const image = (
    <img
      ref={imgRef}
      className={className}
      src={current}
      alt={alt}
      loading={loading}
      fetchPriority={fetchPriority}
      decoding={full ? 'sync' : 'async'}
      onClick={onClick}
      onLoad={(event) => acceptIfScan(event.currentTarget)}
      onError={failCurrent}
      {...drag}
    />
  );

  if (!cut) {
    return image;
  }
  return (
    <span className="art-cut" style={artCutVars(card, cutSurface)}>
      {image}
      {figureMask ? (
        <>
          <img
            className="art-figure-layer art-figure-shadow"
            src={figureMask}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
          />
          <img
            className="art-figure-layer art-figure-hover"
            src={current}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            style={{ '--art-figure-mask': `url("${figureMask}")` }}
          />
        </>
      ) : null}
    </span>
  );
}
