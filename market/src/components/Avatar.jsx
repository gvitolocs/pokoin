import { useState } from 'react';
import { avatarInitials, displayableAvatarUrl } from '../avatar.js';
import '../avatar.css';

/** Round profile picture. Falls back to initials when there is no photo or
 * the photo fails to load. `label` makes it an image for screen readers;
 * without it the avatar is decorative (the surrounding link names it). */
export default function Avatar({ src, name = '', size = 40, silver = false, label = '', className = '' }) {
  const url = displayableAvatarUrl(src);
  const [failedUrl, setFailedUrl] = useState('');
  const showPhoto = Boolean(url) && failedUrl !== url;
  const classes = ['pk-avatar', silver ? 'is-silver' : '', className].filter(Boolean).join(' ');
  return (
    <span
      className={classes}
      style={{ '--avatar-size': `${size}px` }}
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
        <span className="pk-avatar-initials">{avatarInitials(name)}</span>
      )}
    </span>
  );
}
