import { useEffect, useState } from 'react';
import { avatarColor, displayableAvatarUrl, mascotRenderSize } from '../avatar.js';
import mascotUrl from '../assets/pokoin-mascot@8x.png';
import '../avatar.css';

function currentDpr() {
  return typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
}

/** Device pixel ratio that follows browser zoom and monitor moves, so the
 * pixel-art mascot keeps whole device pixels. */
function useDevicePixelRatio(active) {
  const [dpr, setDpr] = useState(currentDpr);
  useEffect(() => {
    if (!active || typeof window === 'undefined' || !window.matchMedia) return undefined;
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const update = () => setDpr(currentDpr());
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, [active, dpr]);
  return dpr;
}

/** Round profile picture. Without a photo (or when it fails to load) it
 * shows the golden Pokoin mascot on the user's pastel. `seed` (uid) keeps
 * the pastel stable; `label` makes it an image for screen readers, without
 * it the avatar is decorative (the surrounding link names it). */
/** `variant="chip"` renders the topbar look: dark disc like the other
 * header chips, the user's pastel as a thin ring. */
export default function Avatar({ src, seed = '', name = '', size = 40, silver = false, label = '', className = '', variant = '' }) {
  const url = displayableAvatarUrl(src);
  const [failedUrl, setFailedUrl] = useState('');
  const showPhoto = Boolean(url) && failedUrl !== url;
  const classes = ['pk-avatar', showPhoto ? '' : 'is-mascot', variant === 'chip' ? 'is-chip' : '', silver ? 'is-silver' : '', className].filter(Boolean).join(' ');
  const dpr = useDevicePixelRatio(!showPhoto);
  const mascot = showPhoto ? null : mascotRenderSize(size, dpr);
  return (
    <span
      className={classes}
      style={{ '--avatar-size': `${size}px`, '--avatar-ground': avatarColor(seed || name) }}
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    >
      {showPhoto ? (
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          decoding="async"
          referrerPolicy="no-referrer"
          draggable="false"
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <img
          className={`pk-avatar-mascot${mascot.crisp ? ' is-crisp' : ''}`}
          src={mascotUrl}
          alt=""
          width="208"
          height="192"
          style={{ width: `${mascot.width}px`, height: `${mascot.height}px` }}
          draggable="false"
        />
      )}
    </span>
  );
}
