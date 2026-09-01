import { useEffect, useMemo, useRef, useState } from 'react';
import { rasterSiblings } from '../api.js';

export default function CardArt({
  src,
  alt = '',
  loading,
  fetchPriority,
  className,
  fallback = 'placeholder',
  onClick,
  onLoad,
}) {
  const urls = useMemo(() => rasterSiblings(src), [src]);
  const [index, setIndex] = useState(0);
  const [dead, setDead] = useState(false);
  const imgRef = useRef(null);

  useEffect(() => {
    setIndex(0);
    setDead(false);
  }, [src]);

  const current = urls[index] || '';

  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0) {
      onLoad?.();
    }
  }, [current, onLoad]);

  if (!current || dead) {
    return fallback === 'hide' ? null : <span className="tile-ph" />;
  }

  return (
    <img
      ref={imgRef}
      className={className}
      src={current}
      alt={alt}
      loading={loading}
      fetchPriority={fetchPriority}
      decoding="async"
      onClick={onClick}
      onLoad={onLoad}
      onError={() => {
        if (index + 1 < urls.length) {
          setIndex(index + 1);
          return;
        }
        setDead(true);
      }}
    />
  );
}
