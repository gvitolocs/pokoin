import { useEffect, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { chatPhotoDisplayUrl, isChatPhotoUrl } from '../user-photo-urls.js';

function AuthChatPhoto({ url }) {
  const { getBearer, signedIn } = useAuth();
  const [src, setSrc] = useState('');
  const href = chatPhotoDisplayUrl(url);

  useEffect(() => {
    let alive = true;
    let objectUrl = '';
    async function load() {
      if (!signedIn || !href) {
        if (alive) setSrc('');
        return;
      }
      try {
        const token = await getBearer();
        const response = await fetch(href, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!response.ok) throw new Error(`photo ${response.status}`);
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        if (alive) setSrc(objectUrl);
      } catch {
        if (alive) setSrc('');
      }
    }
    load();
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [href, signedIn, getBearer]);

  if (!src) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="chat-photo-pending">
        Photo
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer">
      <img src={src} alt="" />
    </a>
  );
}

export default function ChatPhotos({ urls = [] }) {
  if (!urls.length) return null;
  return (
    <span className="chat-photos">
      {urls.map((url) => (
        isChatPhotoUrl(url)
          ? <AuthChatPhoto key={url} url={url} />
          : (
            <a key={url} href={chatPhotoDisplayUrl(url)} target="_blank" rel="noreferrer">
              <img src={chatPhotoDisplayUrl(url)} alt="" />
            </a>
          )
      ))}
    </span>
  );
}
