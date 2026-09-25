import { useEffect, useMemo, useRef, useState } from 'react';
import { artCutVars } from '../art-cut.js';
import { artworkFigureMaskSrc } from '../art-figure-mask.js';
import { cardReference, writeListingDrag } from '../chat-listing.js';
import { rasterSiblings } from '../image-urls.js';
import { isCardTraderPlaceholderSize, MISSING_CARD_SRC } from '../missing-card.js';

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
    const next = indexRef.current + 1;
    if (next < urlsRef.current.length) {
      indexRef.current = next;
      setIndex(next);
      return;
    }
    setDead(true);
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
      failCurrent();
      return;
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
    onError?.();
  }, [urls.length, onError]);

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
  } : {};
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
