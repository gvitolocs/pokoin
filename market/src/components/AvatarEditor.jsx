import { useCallback, useEffect, useRef, useState } from 'react';
import Cropper from 'react-easy-crop';
import 'react-easy-crop/react-easy-crop.css';
import Avatar from './Avatar.jsx';
import { useAuth } from '../auth.jsx';
import { removeProfilePicture, uploadProfilePicture } from '../api.js';
import { AVATAR_ACCEPT, nextRotation, prepareAvatarSource, renderAvatar } from '../avatar.js';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const PREVIEW_SIZE = 192;

/** First image in a FileList. Some Android pickers report an empty type;
 * validateAvatarFile / the decoder decide for those. */
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

/** Profile photo editor sheet. Pick (file, camera, drop, paste) → crop
 * (drag / pinch / wheel / keys, 90° turns) → upload. */
export default function AvatarEditor({ open, onClose, name, seed = '', photoUrl, onSaved }) {
  const { getBearer, setProfilePhoto } = useAuth();
  const [step, setStep] = useState('pick');
  const [source, setSource] = useState(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [area, setArea] = useState(null);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const sheetRef = useRef(null);
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const returnFocusRef = useRef(null);
  const touch = isTouchDevice();

  const replaceSource = useCallback((next) => {
    setSource((current) => {
      if (current?.url && current.url !== next?.url) URL.revokeObjectURL(current.url);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    replaceSource(null);
    setStep('pick');
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setRotation(0);
    setArea(null);
    setPreview('');
    setBusy('');
    setError('');
    setDragging(false);
    setConfirmRemove(false);
  }, [replaceSource]);

  const close = useCallback(() => {
    if (busy === 'saving' || busy === 'removing') return;
    reset();
    onClose?.();
  }, [busy, onClose, reset]);

  // Open: remember focus, lock page scroll, focus the sheet. Close: restore.
  useEffect(() => {
    if (!open) return undefined;
    returnFocusRef.current = document.activeElement;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    const timer = setTimeout(() => sheetRef.current?.querySelector('button, [href], input')?.focus(), 30);
    return () => {
      clearTimeout(timer);
      document.body.style.overflow = overflow;
      returnFocusRef.current?.focus?.();
    };
  }, [open]);

  useEffect(() => () => replaceSource(null), [replaceSource]);

  const loadFile = useCallback(async (file) => {
    setError('');
    setConfirmRemove(false);
    if (!file) return;
    setBusy('loading');
    try {
      const next = await prepareAvatarSource(file);
      replaceSource(next);
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setRotation(0);
      setPreview('');
      setStep('crop');
    } catch (err) {
      setError(shownError(err, 'Could not open that photo.'));
    } finally {
      setBusy('');
    }
  }, [replaceSource]);

  // Escape closes; Ctrl/Cmd+V pastes a copied image while picking.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    const onPaste = (event) => {
      if (step !== 'pick') return;
      const file = firstImageFile(event.clipboardData?.files);
      if (file) {
        event.preventDefault();
        loadFile(file);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('paste', onPaste);
    };
  }, [open, step, close, loadFile]);

  // Live preview once a drag / pinch / slider move settles.
  useEffect(() => {
    if (step !== 'crop' || !source?.url || !area) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      renderAvatar(source.url, area, rotation, PREVIEW_SIZE)
        .then((url) => { if (!cancelled) setPreview(url); })
        .catch(() => {});
    }, 90);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [step, source?.url, area, rotation]);

  async function save() {
    if (!source?.url || !area) return;
    setBusy('saving');
    setError('');
    try {
      const dataUrl = await renderAvatar(source.url, area, rotation);
      const token = await getBearer();
      if (!token) throw new Error('Sign in again to change your photo.');
      const result = await uploadProfilePicture(dataUrl, token);
      setProfilePhoto(result?.photoUrl || '');
      setBusy('');
      reset();
      onSaved?.('Profile photo updated');
      onClose?.();
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
      onSaved?.('Profile photo removed');
      onClose?.();
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

  if (!open) return null;
  const saving = busy === 'saving';
  const hasPhoto = Boolean(photoUrl);

  return (
    <div className="avatar-sheet-backdrop" onClick={close}>
      <div
        ref={sheetRef}
        className={`avatar-sheet is-${step}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="avatar-sheet-grab" aria-hidden="true" />
        <div className="avatar-sheet-head">
          <h2 id="avatar-sheet-title">{step === 'crop' ? 'Adjust your photo' : 'Profile photo'}</h2>
          <button className="avatar-sheet-close" type="button" aria-label="Close" onClick={close} disabled={saving}>×</button>
        </div>

        <input ref={fileRef} id="avatar-file" type="file" accept={AVATAR_ACCEPT} hidden onChange={onPick} />
        <input ref={cameraRef} id="avatar-camera" type="file" accept="image/*" capture="user" hidden onChange={onPick} />

        {step === 'pick' ? (
          <div className="avatar-pick">
            <div
              className={`avatar-drop${dragging ? ' is-over' : ''}${busy === 'loading' ? ' is-busy' : ''}`}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <Avatar src={photoUrl} seed={seed} name={name} size={112} />
              <p className="avatar-drop-copy">
                {busy === 'loading' ? 'Opening photo…' : 'Drag a photo here or paste one.'}
              </p>
              <p className="avatar-drop-hint">JPG, PNG, WebP or GIF · up to 25 MB · you crop it next</p>
            </div>
            <div className="avatar-options" role="group" aria-label="Photo source">
              <button className="avatar-option" type="button" onClick={() => fileRef.current?.click()} disabled={Boolean(busy)}>
                <span className="avatar-option-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6 4h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm8 1.5V10h4.5L14 5.5ZM8 13h8v2H8v-2Zm0 4h5v2H8v-2Z" /></svg>
                </span>
                <span className="avatar-option-copy">
                  <strong>{touch ? 'Choose from gallery' : 'Upload a photo'}</strong>
                  <small>JPG, PNG, WebP or GIF</small>
                </span>
              </button>
              <button className="avatar-option" type="button" onClick={() => cameraRef.current?.click()} disabled={Boolean(busy)}>
                <span className="avatar-option-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M9 3h6l1.2 2H20a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3.8L9 3Zm3 5.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Zm0 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z" /></svg>
                </span>
                <span className="avatar-option-copy">
                  <strong>Take a photo</strong>
                  <small>Use your camera</small>
                </span>
              </button>
              {hasPhoto && confirmRemove ? (
                <div className="avatar-confirm" role="group" aria-label="Confirm removal">
                  <span>Remove your photo? The Pokoin mascot shows instead.</span>
                  <button className="btn danger" type="button" onClick={remove} disabled={busy === 'removing'}>
                    {busy === 'removing' ? 'Removing…' : 'Remove'}
                  </button>
                  <button className="btn ghost" type="button" onClick={() => setConfirmRemove(false)} disabled={busy === 'removing'}>
                    Keep it
                  </button>
                </div>
              ) : null}
              {hasPhoto && !confirmRemove ? (
                <button className="avatar-option is-danger" type="button" onClick={() => setConfirmRemove(true)} disabled={Boolean(busy)}>
                  <span className="avatar-option-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h2v9H7V9Zm4 0h2v9h-2V9Zm4 0h2v9h-2V9ZM6 21a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8H6v13Z" /></svg>
                  </span>
                  <span className="avatar-option-copy">
                    <strong>Remove current photo</strong>
                    <small>The Pokoin mascot shows instead</small>
                  </span>
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {step === 'crop' && source ? (
          <div className="avatar-crop">
            <div className="avatar-crop-stage">
              <Cropper
                image={source.url}
                crop={crop}
                zoom={zoom}
                rotation={rotation}
                minZoom={MIN_ZOOM}
                maxZoom={MAX_ZOOM}
                aspect={1}
                cropShape="round"
                showGrid={false}
                objectFit="cover"
                zoomSpeed={0.6}
                keyboardStep={8}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onRotationChange={setRotation}
                onCropComplete={(_, pixels) => setArea(pixels)}
                disableAutomaticStylesInjection
                classes={{ containerClassName: 'avatar-cropper', cropAreaClassName: 'avatar-crop-area' }}
                mediaProps={{ alt: 'Photo to crop' }}
                cropperProps={{ 'aria-label': 'Crop area. Drag or use arrow keys to move, pinch or scroll to zoom.' }}
              />
            </div>

            <div className="avatar-zoom">
              <button type="button" className="avatar-icon-btn" aria-label="Zoom out" onClick={() => nudgeZoom(-0.2)} disabled={zoom <= MIN_ZOOM || saving}>−</button>
              <input
                id="avatar-zoom"
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step="0.01"
                value={zoom}
                aria-label="Zoom"
                onChange={(event) => setZoom(Number(event.target.value))}
                disabled={saving}
              />
              <button type="button" className="avatar-icon-btn" aria-label="Zoom in" onClick={() => nudgeZoom(0.2)} disabled={zoom >= MAX_ZOOM || saving}>+</button>
              <button
                type="button"
                className="avatar-icon-btn"
                aria-label="Rotate 90 degrees"
                title="Rotate"
                onClick={() => setRotation((value) => nextRotation(value))}
                disabled={saving}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z" /></svg>
              </button>
            </div>

            <div className="avatar-previews" aria-label="Preview">
              <span className="avatar-preview-label">Preview</span>
              <Avatar src={preview || undefined} seed={seed} name={name} size={72} />
              <Avatar src={preview || undefined} seed={seed} name={name} size={40} />
              <Avatar src={preview || undefined} seed={seed} name={name} size={24} />
            </div>

            <div className="avatar-actions">
              <button className="btn" type="button" onClick={save} disabled={saving || !area}>
                {saving ? 'Saving…' : 'Save photo'}
              </button>
              <button className="btn ghost" type="button" onClick={() => { setError(''); setStep('pick'); }} disabled={saving}>
                Choose another
              </button>
            </div>
          </div>
        ) : null}

        {error ? <p className="avatar-error" role="alert">{error}</p> : null}
      </div>
    </div>
  );
}
