import { createEffect, createSignal, onSettled, Show } from 'solid-js';
import { removeProfilePicture, uploadProfilePicture } from '@market/api.js';
import { AVATAR_ACCEPT, nextRotation, safeAvatarUrl } from '@market/avatar.js';
import { prepareAvatarSource, renderAvatar } from '@market/avatar-render.js';
import Avatar from '../Avatar.jsx';
import { patchAccountProfile } from '../../stores/account.js';
import { getBearer } from '../../stores/auth.js';
import AvatarCropper from './AvatarCropper.jsx';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const PREVIEW_SIZE = 192;

/** First image in a FileList. Some Android pickers report an empty type. */
function firstImageFile(list) {
  const files = [...(list || [])];
  return files.find((file) => String(file.type || '').startsWith('image/'))
    || files.find((file) => !file.type)
    || files[0]
    || null;
}

function isTouchDevice() {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
}

/** Library dumps (Sharp on the Pi, npm install hints) must not land in the sheet. */
function shownError(error, fallback) {
  const message = String(error?.message || '').replace(/\s+/g, ' ').trim();
  if (!message || message.length > 160 || /sharp|pixelplumbing|npm install|linux-arm64|cannot find module/i.test(message)) {
    return fallback;
  }
  return message;
}

function setProfilePhoto(url) {
  patchAccountProfile({ photoUrl: safeAvatarUrl(url) });
}

/**
 * Profile photo editor sheet. Pick
 * (file, camera, drop, paste) → crop (drag / pinch / wheel / keys, 90° turns)
 * → upload. Mounted while open.
 */
export default function AvatarEditor(props) {
  const [step, setStep] = createSignal('pick');
  const [source, setSource] = createSignal(null);
  const [zoom, setZoom] = createSignal(1);
  const [rotation, setRotation] = createSignal(0);
  const [area, setArea] = createSignal(null);
  const [preview, setPreview] = createSignal('');
  const [busy, setBusy] = createSignal('');
  const [error, setError] = createSignal('');
  const [dragging, setDragging] = createSignal(false);
  const [confirmRemove, setConfirmRemove] = createSignal(false);
  // A new photo remounts the cropper so its position starts centred.
  const [cropKey, setCropKey] = createSignal(0);
  let sheet;
  let fileInput;
  let cameraInput;
  const touch = isTouchDevice();

  function replaceSource(next) {
    const current = source();
    if (current?.url && current.url !== next?.url) URL.revokeObjectURL(current.url);
    setSource(() => next);
  }

  function reset() {
    replaceSource(null);
    setStep('pick');
    setZoom(1);
    setRotation(0);
    setArea(null);
    setPreview('');
    setBusy('');
    setError('');
    setDragging(false);
    setConfirmRemove(false);
  }

  function close() {
    if (busy() === 'saving' || busy() === 'removing') return;
    reset();
    props.onClose?.();
  }

  async function loadFile(file) {
    setError('');
    setConfirmRemove(false);
    if (!file) return;
    setBusy('loading');
    try {
      const next = await prepareAvatarSource(file);
      replaceSource(next);
      setZoom(1);
      setRotation(0);
      setPreview('');
      setCropKey((n) => n + 1);
      setStep('crop');
    } catch (err) {
      setError(shownError(err, 'Could not open that photo.'));
    } finally {
      setBusy('');
    }
  }

  // Open: remember focus, lock page scroll, focus the sheet; Escape closes and
  // Ctrl/Cmd+V pastes a copied image while picking. Close: restore.
  onSettled(() => {
    const returnFocus = document.activeElement;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    const timer = setTimeout(() => sheet?.querySelector('button, [href], input')?.focus(), 30);
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    const onPaste = (event) => {
      if (step() !== 'pick') return;
      const file = firstImageFile(event.clipboardData?.files);
      if (file) {
        event.preventDefault();
        loadFile(file);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('paste', onPaste);
      document.body.style.overflow = overflow;
      returnFocus?.focus?.();
      const current = source();
      if (current?.url) URL.revokeObjectURL(current.url);
    };
  });

  // Live preview once a drag / pinch / slider move settles.
  createEffect(
    () => (step() === 'crop' && source()?.url && area() ? { url: source().url, area: area(), rotation: rotation() } : null),
    (input) => {
      if (!input) return undefined;
      let cancelled = false;
      const timer = setTimeout(() => {
        renderAvatar(input.url, input.area, input.rotation, PREVIEW_SIZE)
          .then((url) => { if (!cancelled) setPreview(url); })
          .catch(() => {});
      }, 90);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    },
  );

  async function save() {
    if (!source()?.url || !area()) return;
    setBusy('saving');
    setError('');
    try {
      const dataUrl = await renderAvatar(source().url, area(), rotation());
      const token = await getBearer();
      if (!token) throw new Error('Sign in again to change your photo.');
      const result = await uploadProfilePicture(dataUrl, token);
      setProfilePhoto(result?.photoUrl || '');
      setBusy('');
      reset();
      props.onSaved?.('Profile photo updated');
      props.onClose?.();
    } catch (err) {
      setBusy('');
      setError(shownError(err, 'Could not save your photo. Try again.'));
    }
  }

  async function remove() {
    setBusy('removing');
    setError('');
    try {
      const token = await getBearer();
      if (!token) throw new Error('Sign in again to change your photo.');
      await removeProfilePicture(token);
      setProfilePhoto('');
      setBusy('');
      reset();
      props.onSaved?.('Profile photo removed');
      props.onClose?.();
    } catch (err) {
      setBusy('');
      setError(shownError(err, 'Could not remove the photo.'));
    }
  }

  function onPick(event) {
    const file = firstImageFile(event.target.files);
    event.target.value = '';
    loadFile(file);
  }

  function onDrop(event) {
    event.preventDefault();
    setDragging(false);
    loadFile(firstImageFile(event.dataTransfer?.files));
  }

  const nudgeZoom = (delta) => setZoom((value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((value + delta).toFixed(2)))));
  const saving = () => busy() === 'saving';
  const hasPhoto = () => Boolean(props.photoUrl);

  return (
    <div class="avatar-sheet-backdrop" onClick={close}>
      <div
        ref={(el) => { sheet = el; }}
        class={['avatar-sheet', `is-${step()}`]}
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div class="avatar-sheet-grab" aria-hidden="true" />
        <div class="avatar-sheet-head">
          <h2 id="avatar-sheet-title">{step() === 'crop' ? 'Adjust your photo' : 'Profile photo'}</h2>
          <button class="avatar-sheet-close" type="button" aria-label="Close" onClick={close} disabled={saving()}>×</button>
        </div>

        <input ref={(el) => { fileInput = el; }} id="avatar-file" type="file" accept={AVATAR_ACCEPT} hidden onChange={onPick} />
        <input ref={(el) => { cameraInput = el; }} id="avatar-camera" type="file" accept="image/*" capture="user" hidden onChange={onPick} />

        <Show when={step() === 'pick'}>
          <div class="avatar-pick">
            <div
              class={['avatar-drop', { 'is-over': dragging(), 'is-busy': busy() === 'loading' }]}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <Avatar src={props.photoUrl} seed={props.seed || ''} name={props.name} size={112} />
              <p class="avatar-drop-copy">{busy() === 'loading' ? 'Opening photo…' : 'Drag a photo here or paste one.'}</p>
              <p class="avatar-drop-hint">JPG, PNG, WebP or GIF · up to 25 MB · saved as a JPEG under 0.7 MB</p>
            </div>
            <div class="avatar-options" role="group" aria-label="Photo source">
              <button class="avatar-option" type="button" onClick={() => fileInput?.click()} disabled={Boolean(busy())}>
                <span class="avatar-option-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6 4h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm8 1.5V10h4.5L14 5.5ZM8 13h8v2H8v-2Zm0 4h5v2H8v-2Z" /></svg>
                </span>
                <span class="avatar-option-copy">
                  <strong>{touch ? 'Choose from gallery' : 'Upload a photo'}</strong>
                  <small>JPG, PNG, WebP or GIF</small>
                </span>
              </button>
              <button class="avatar-option" type="button" onClick={() => cameraInput?.click()} disabled={Boolean(busy())}>
                <span class="avatar-option-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M9 3h6l1.2 2H20a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3.8L9 3Zm3 5.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Zm0 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z" /></svg>
                </span>
                <span class="avatar-option-copy">
                  <strong>Take a photo</strong>
                  <small>Use your camera</small>
                </span>
              </button>
              <Show when={hasPhoto() && confirmRemove()}>
                <div class="avatar-confirm" role="group" aria-label="Confirm removal">
                  <span>Remove your photo? The Pokoin mascot shows instead.</span>
                  <button class="btn danger" type="button" onClick={remove} disabled={busy() === 'removing'}>
                    {busy() === 'removing' ? 'Removing…' : 'Remove'}
                  </button>
                  <button class="btn ghost" type="button" onClick={() => setConfirmRemove(false)} disabled={busy() === 'removing'}>Keep it</button>
                </div>
              </Show>
              <Show when={hasPhoto() && !confirmRemove()}>
                <button class="avatar-option is-danger" type="button" onClick={() => setConfirmRemove(true)} disabled={Boolean(busy())}>
                  <span class="avatar-option-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h2v9H7V9Zm4 0h2v9h-2V9Zm4 0h2v9h-2V9ZM6 21a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8H6v13Z" /></svg>
                  </span>
                  <span class="avatar-option-copy">
                    <strong>Remove current photo</strong>
                    <small>The Pokoin mascot shows instead</small>
                  </span>
                </button>
              </Show>
            </div>
          </div>
        </Show>

        <Show when={step() === 'crop' && source()}>
          <div class="avatar-crop">
            <div class="avatar-crop-stage">
              <Show when={cropKey()} keyed>
                {() => (
                  <AvatarCropper
                    image={source().url}
                    zoom={zoom()}
                    rotation={rotation()}
                    minZoom={MIN_ZOOM}
                    maxZoom={MAX_ZOOM}
                    zoomSpeed={0.6}
                    keyboardStep={8}
                    onZoomChange={setZoom}
                    onCropComplete={(pixels) => setArea(pixels)}
                    alt="Photo to crop"
                    label="Crop area. Drag or use arrow keys to move, pinch or scroll to zoom."
                  />
                )}
              </Show>
            </div>

            <div class="avatar-zoom">
              <button type="button" class="avatar-icon-btn" aria-label="Zoom out" onClick={() => nudgeZoom(-0.2)} disabled={zoom() <= MIN_ZOOM || saving()}>−</button>
              <input
                id="avatar-zoom"
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step="0.01"
                value={zoom()}
                aria-label="Zoom"
                onInput={(event) => setZoom(Number(event.target.value))}
                disabled={saving()}
              />
              <button type="button" class="avatar-icon-btn" aria-label="Zoom in" onClick={() => nudgeZoom(0.2)} disabled={zoom() >= MAX_ZOOM || saving()}>+</button>
              <button
                type="button"
                class="avatar-icon-btn"
                aria-label="Rotate 90 degrees"
                title="Rotate"
                onClick={() => setRotation((value) => nextRotation(value))}
                disabled={saving()}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z" /></svg>
              </button>
            </div>

            <div class="avatar-previews" aria-label="Preview">
              <span class="avatar-preview-label">Preview</span>
              <Avatar src={preview() || undefined} seed={props.seed || ''} name={props.name} size={72} />
              <Avatar src={preview() || undefined} seed={props.seed || ''} name={props.name} size={40} />
              <Avatar src={preview() || undefined} seed={props.seed || ''} name={props.name} size={24} />
            </div>

            <div class="avatar-actions">
              <button class="btn" type="button" onClick={save} disabled={saving() || !area()}>{saving() ? 'Saving…' : 'Save photo'}</button>
              <button class="btn ghost" type="button" onClick={() => { setError(''); setStep('pick'); }} disabled={saving()}>Choose another</button>
            </div>
          </div>
        </Show>

        <Show when={error()}><p class="avatar-error" role="alert">{error()}</p></Show>
      </div>
    </div>
  );
}
