import { createEffect, createSignal, For, Show } from 'solid-js';
import { chatPhotoDisplayUrl, isChatPhotoUrl } from '@market/user-photo-urls.js';
import { getBearer, signedIn } from '../stores/auth.js';

/** A private chat photo: fetched with the bearer, shown from a blob URL revoked on change. */
function AuthChatPhoto(props) {
  const [src, setSrc] = createSignal('');
  const href = () => chatPhotoDisplayUrl(props.url);

  createEffect(
    () => [href(), signedIn()],
    ([target, on]) => {
      let alive = true;
      let objectUrl = '';
      (async () => {
        if (!on || !target) {
          if (alive) setSrc('');
          return;
        }
        try {
          const token = await getBearer();
          const response = await fetch(target, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
          if (!response.ok) throw new Error(`photo ${response.status}`);
          const blob = await response.blob();
          objectUrl = URL.createObjectURL(blob);
          if (alive) setSrc(objectUrl);
        } catch {
          if (alive) setSrc('');
        }
      })();
      return () => {
        alive = false;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    },
  );

  return (
    <Show
      when={src()}
      fallback={<a href={href()} target="_blank" rel="noreferrer" class="chat-photo-pending">Photo</a>}
    >
      <a href={href()} target="_blank" rel="noreferrer"><img src={src()} alt="" /></a>
    </Show>
  );
}

/** Photos on a chat message or draft (market/src/components/ChatPhotos.jsx). */
export default function ChatPhotos(props) {
  const urls = () => props.urls || [];
  return (
    <Show when={urls().length}>
      <span class="chat-photos">
        <For each={urls()}>
          {(url) => (isChatPhotoUrl(url)
            ? <AuthChatPhoto url={url} />
            : (
              <a href={chatPhotoDisplayUrl(url)} target="_blank" rel="noreferrer">
                <img src={chatPhotoDisplayUrl(url)} alt="" />
              </a>
            ))}
        </For>
      </span>
    </Show>
  );
}
