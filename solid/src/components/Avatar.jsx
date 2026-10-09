import { createEffect, createSignal, Show } from 'solid-js';
import { avatarColor, displayableAvatarUrl, mascotRenderSize } from '@market/avatar.js';
import mascotUrl from '@market/assets/pokoin-mascot@8x.png';
import '@market/avatar.css';

function currentDpr() {
  return typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
}

/**
 * Round profile picture (market/src/components/Avatar.jsx). Without a photo
 * (or when it fails to load) it shows the golden Pokoin mascot on the user's
 * pastel; `seed` (uid) keeps the pastel stable. `label` makes it an image for
 * screen readers, otherwise it is decorative. `variant="chip"` is the topbar
 * look. The mascot keeps whole device pixels as zoom / monitor DPR changes —
 * that media listener exists only while the mascot is shown.
 */
export default function Avatar(props) {
  const size = () => props.size ?? 40;
  const url = () => displayableAvatarUrl(props.src);
  const [failedUrl, setFailedUrl] = createSignal('');
  const showPhoto = () => Boolean(url()) && failedUrl() !== url();
  const [dpr, setDpr] = createSignal(currentDpr());
  createEffect(
    () => (showPhoto() ? 0 : dpr()),
    (watching) => {
      if (!watching || typeof window === 'undefined' || !window.matchMedia) return undefined;
      const query = window.matchMedia(`(resolution: ${watching}dppx)`);
      const update = () => setDpr(currentDpr());
      query.addEventListener?.('change', update);
      return () => query.removeEventListener?.('change', update);
    },
  );
  const mascot = () => mascotRenderSize(size(), dpr());
  return (
    <span
      class={[
        'pk-avatar',
        props.class,
        { 'is-mascot': !showPhoto(), 'is-chip': props.variant === 'chip', 'is-silver': Boolean(props.silver) },
      ]}
      style={{ '--avatar-size': `${size()}px`, '--avatar-ground': avatarColor(props.seed || props.name || '') }}
      role={props.label ? 'img' : undefined}
      aria-label={props.label || undefined}
      aria-hidden={props.label ? undefined : 'true'}
    >
      <Show
        when={showPhoto()}
        fallback={(
          <img
            class={['pk-avatar-mascot', { 'is-crisp': mascot().crisp }]}
            src={mascotUrl}
            alt=""
            width="208"
            height="192"
            style={{ width: `${mascot().width}px`, height: `${mascot().height}px` }}
            draggable="false"
          />
        )}
      >
        <img
          src={url()}
          alt=""
          width={size()}
          height={size()}
          decoding="async"
          referrerpolicy="no-referrer"
          draggable="false"
          onError={() => setFailedUrl(url())}
        />
      </Show>
    </span>
  );
}
