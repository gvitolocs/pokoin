import { createEffect, createSignal, onSettled } from 'solid-js';
import './avatar-cropper.css';

/**
 * Square, round-guide photo cropper for the profile photo sheet: the subset
 * of react-easy-crop the React AvatarEditor used (aspect 1, object-fit cover,
 * drag / pinch / wheel / arrow keys, 90° rotation). `onCropComplete` gets the
 * crop in source pixels of the rotated image, as react-easy-crop reports it,
 * which is what market/src/avatar.js renderAvatar expects.
 */
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const limitArea = (max, value) => Math.min(max, Math.max(0, value));

function rotateSize(width, height, rotation) {
  const rad = (rotation * Math.PI) / 180;
  return {
    width: Math.abs(Math.cos(rad) * width) + Math.abs(Math.sin(rad) * height),
    height: Math.abs(Math.sin(rad) * width) + Math.abs(Math.cos(rad) * height),
  };
}

function restrict(crop, media, cropSize, zoom, rotation) {
  const box = rotateSize(media.width, media.height, rotation);
  const maxX = Math.max(0, (box.width * zoom) / 2 - cropSize / 2);
  const maxY = Math.max(0, (box.height * zoom) / 2 - cropSize / 2);
  return { x: clamp(crop.x, -maxX, maxX), y: clamp(crop.y, -maxY, maxY) };
}

/** react-easy-crop computeCroppedArea (restricted position, aspect 1). */
export function croppedAreaPixels(crop, media, natural, cropSize, zoom, rotation) {
  const box = rotateSize(media.width, media.height, rotation);
  const naturalBox = rotateSize(natural.width, natural.height, rotation);
  const pct = {
    x: limitArea(100, (((box.width - cropSize / zoom) / 2 - crop.x / zoom) / box.width) * 100),
    y: limitArea(100, (((box.height - cropSize / zoom) / 2 - crop.y / zoom) / box.height) * 100),
    width: limitArea(100, ((cropSize / box.width) * 100) / zoom),
    height: limitArea(100, ((cropSize / box.height) * 100) / zoom),
  };
  const widthPx = Math.round(limitArea(naturalBox.width, (pct.width * naturalBox.width) / 100));
  const heightPx = Math.round(limitArea(naturalBox.height, (pct.height * naturalBox.height) / 100));
  const wide = naturalBox.width >= naturalBox.height;
  const size = wide ? { width: heightPx, height: heightPx } : { width: widthPx, height: widthPx };
  return {
    ...size,
    x: Math.round(limitArea(naturalBox.width - size.width, (pct.x * naturalBox.width) / 100)),
    y: Math.round(limitArea(naturalBox.height - size.height, (pct.y * naturalBox.height) / 100)),
  };
}

export default function AvatarCropper(props) {
  let container;
  let image;
  const [crop, setCrop] = createSignal({ x: 0, y: 0 });
  const [media, setMedia] = createSignal(null);
  const [cropSize, setCropSize] = createSignal(0);
  const [cover, setCover] = createSignal('horizontal');
  const pointers = new Map();
  let pinch = null;
  let drag = null;

  const zoom = () => props.zoom;
  const rotation = () => props.rotation || 0;

  function measure() {
    if (!container || !image?.naturalWidth) return;
    const side = Math.min(container.clientWidth, container.clientHeight);
    const aspect = image.naturalWidth / image.naturalHeight;
    const containerAspect = container.clientWidth / container.clientHeight;
    setCover(aspect > containerAspect ? 'vertical' : 'horizontal');
    const width = aspect > containerAspect ? container.clientHeight * aspect : container.clientWidth;
    const height = aspect > containerAspect ? container.clientHeight : container.clientWidth / aspect;
    setMedia({ width, height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight });
    setCropSize(side);
  }

  function move(next) {
    const size = media();
    if (!size) return;
    setCrop(restrict(next, size, cropSize(), zoom(), rotation()));
  }

  function setZoomTo(next) {
    props.onZoomChange?.(clamp(Number(next.toFixed(3)), props.minZoom ?? 1, props.maxZoom ?? 4));
  }

  onSettled(() => {
    const observer = new ResizeObserver(() => measure());
    if (container) observer.observe(container);
    return () => observer.disconnect();
  });

  // Keep the crop inside the photo after zoom or rotation, then report it.
  createEffect(
    () => ({ size: media(), zoom: zoom(), rotation: rotation(), side: cropSize() }),
    ({ size, zoom: z, rotation: r, side }) => {
      if (!size || !side) return;
      const fixed = restrict(crop(), size, side, z, r);
      if (fixed.x !== crop().x || fixed.y !== crop().y) setCrop(fixed);
    },
  );
  createEffect(
    () => (media() && cropSize() ? { at: crop(), size: media(), side: cropSize(), z: zoom(), r: rotation() } : null),
    (state) => {
      if (!state) return;
      const { at, size, side, z, r } = state;
      const pixels = croppedAreaPixels(at, size, { width: size.naturalWidth, height: size.naturalHeight }, side, z, r);
      props.onCropComplete?.(pixels);
    },
  );

  function onPointerDown(event) {
    container.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: zoom() };
      drag = null;
    } else if (pointers.size === 1) {
      drag = { x: event.clientX, y: event.clientY, crop: crop() };
    }
  }

  function onPointerMove(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.distance > 0) setZoomTo(pinch.zoom * (distance / pinch.distance));
      return;
    }
    if (drag) move({ x: drag.crop.x + event.clientX - drag.x, y: drag.crop.y + event.clientY - drag.y });
  }

  function onPointerUp(event) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) {
      const [rest] = [...pointers.values()];
      drag = { x: rest.x, y: rest.y, crop: crop() };
    } else if (!pointers.size) {
      drag = null;
    }
  }

  function onWheel(event) {
    event.preventDefault();
    setZoomTo(zoom() - (event.deltaY * (props.zoomSpeed ?? 1)) / 200);
  }

  function onKeyDown(event) {
    const step = props.keyboardStep ?? 1;
    const delta = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] }[event.key];
    if (!delta) return;
    event.preventDefault();
    move({ x: crop().x + delta[0], y: crop().y + delta[1] });
  }

  return (
    <div
      ref={(el) => {
        container = el;
        el.addEventListener('wheel', onWheel, { passive: false });
      }}
      class="reactEasyCrop_Container avatar-cropper"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <img
        ref={(el) => { image = el; }}
        src={props.image}
        alt={props.alt || ''}
        draggable="false"
        class={['reactEasyCrop_Image', cover() === 'vertical' ? 'reactEasyCrop_Cover_Vertical' : 'reactEasyCrop_Cover_Horizontal']}
        style={{ transform: `translate(${crop().x}px, ${crop().y}px) rotate(${rotation()}deg) scale(${zoom()})` }}
        onLoad={measure}
      />
      <div
        class="reactEasyCrop_CropArea reactEasyCrop_CropAreaRound avatar-crop-area"
        style={{ width: `${cropSize()}px`, height: `${cropSize()}px` }}
        tabindex="0"
        aria-label={props.label}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
