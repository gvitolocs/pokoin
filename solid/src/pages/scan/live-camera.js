// Camera, photo and live-identify loop for /scan. A port of the phone scanner
// at scan.pokoin.com (pokoin-scanner service/web/index.html): same capture
// sizes, JPEG quality, tilt correction, cadence and busy retries, so a frame
// from either page is the same request to the Pi API. Scoring and links live
// in @market/scan-live.js; this file only touches the DOM.

import {
  fitCardRect,
  LIVE_MS,
  mapContain,
  preferredCamera,
  readScanResult,
  scanIdentifyUrl,
  uprightRoll,
} from '@market/scan-live.js';

const LIVE_MAX_SIDE = 960;
const PHOTO_MAX_SIDE = 1280;
const REQUEST_TIMEOUT_MS = 20000;
const PHOTO_BUSY_RETRIES = 12;
const TILT_ALPHA = 0.3;
const TILT_STALE_MS = 1000;
const TILT_CLAMP = 45;

function cameraConstraints() {
  // Sensor orientation: the browser rotates the delivered frame, so swapping
  // these with the viewport would rotate it twice.
  return {
    width: { ideal: 1280 },
    height: { ideal: 960 },
    aspectRatio: { ideal: 4 / 3 },
    resizeMode: { ideal: 'none' },
  };
}

function frameSize(source, max) {
  const w = source.videoWidth || source.naturalWidth || source.width;
  const h = source.videoHeight || source.naturalHeight || source.height;
  if (!w || !h) return null;
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

function blobFromCanvas(source, max, quality = 0.72, rollDeg = 0) {
  const frame = frameSize(source, max);
  if (!frame) return Promise.resolve(null);
  const w = source.videoWidth || source.naturalWidth || source.width;
  const h = source.videoHeight || source.naturalHeight || source.height;
  const roll = Number(rollDeg) || 0;
  const upright = Math.abs(roll) >= 3;
  const cos = Math.abs(Math.cos((roll * Math.PI) / 180));
  const sin = Math.abs(Math.sin((roll * Math.PI) / 180));
  const canvas = document.createElement('canvas');
  // The rotated bounding box keeps every frame pixel inside the upload.
  canvas.width = upright ? Math.max(1, Math.round(frame.w * cos + frame.h * sin)) : frame.w;
  canvas.height = upright ? Math.max(1, Math.round(frame.w * sin + frame.h * cos)) : frame.h;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (upright) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((-roll * Math.PI) / 180);
    ctx.drawImage(source, 0, 0, w, h, -frame.w / 2, -frame.h / 2, frame.w, frame.h);
    ctx.restore();
  } else {
    ctx.drawImage(source, 0, 0, w, h, 0, 0, canvas.width, canvas.height);
  }
  const q = Math.min(0.92, Math.max(0.4, Number(quality) || 0.72));
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', q));
}

/**
 * @param {object} opts
 * @param {HTMLVideoElement} opts.video
 * @param {HTMLImageElement} opts.photo
 * @param {HTMLCanvasElement} opts.overlay
 * @param {() => string} opts.catalog  current catalog id
 * @param {() => string} opts.game     game of that catalog
 * @param {() => 'single'|'multi'} opts.mode
 * @param {(result: object, info: {live: boolean}) => void} opts.onResult
 * @param {(state: object) => void} opts.onState  camera / torch / camera list
 * @param {(text: string) => void} opts.onStatus
 */
export function createLiveCamera(opts) {
  const { video, photo, overlay } = opts;
  let stream = null;
  let track = null;
  let camReady = false;
  let busy = false;
  let locked = false;
  let liveTimer = null;
  let scanRevision = 0;
  let viewVersion = 0;
  let cameraRequest = 0;
  let requestController = null;
  let photoSource = null;
  let photoUrl = '';
  let torchOn = false;
  let pulse = 0;
  let pulseRaf = 0;
  let destroyed = false;
  let boxes = null;
  let imgW = 0;
  let imgH = 0;
  let lastRoll = 0;
  let origW = 0;
  let origH = 0;
  let tiltX = 1;
  let tiltY = 0;
  let tiltHave = false;
  let tiltReading = null;
  let tiltAt = 0;
  let tiltAsked = false;

  const state = { camera: 'idle', photo: false, torch: false, torchOn: false, cameras: [], deviceId: '' };
  function setState(patch) {
    Object.assign(state, patch);
    opts.onState?.({ ...state });
  }

  function catalog() { return opts.catalog?.() || ''; }
  function mode() { return opts.mode?.() === 'multi' ? 'multi' : 'single'; }

  // ---------- overlay ----------
  function unrollPoint(x, y) {
    const rad = (lastRoll * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = x - imgW / 2;
    const dy = y - imgH / 2;
    const ox = dx * cos - dy * sin + origW / 2;
    const oy = dx * sin + dy * cos + origH / 2;
    const scale = Math.min(overlay.width / origW, overlay.height / origH);
    return {
      x: ox * scale + (overlay.width - origW * scale) / 2,
      y: oy * scale + (overlay.height - origH * scale) / 2,
    };
  }

  function paintOverlay() {
    if (!overlay.isConnected) return;
    const ctx = overlay.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(overlay.clientWidth * dpr);
    const height = Math.round(overlay.clientHeight * dpr);
    if (overlay.width !== width) overlay.width = width;
    if (overlay.height !== height) overlay.height = height;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!boxes || !boxes.length || !imgW || !imgH) return;
    const alpha = 0.55 + 0.4 * (0.5 + 0.5 * Math.sin(pulse * Math.PI * 2));
    ctx.strokeStyle = `rgba(255,211,61,${alpha.toFixed(3)})`;
    ctx.lineWidth = 3 * dpr;
    ctx.lineJoin = 'round';
    const limit = mode() === 'multi' ? Math.min(boxes.length, 16) : 1;
    const snapCard = opts.game?.() === 'pokemon';
    for (let i = 0; i < limit; i += 1) {
      const xy = boxes[i]?.xyxy || [];
      if (xy.length < 4) continue;
      if (lastRoll) {
        // The box lives in the rotated upload: fit it there, then un-rotate
        // the corners so the preview shows the true card polygon.
        let r = { x: xy[0], y: xy[1], w: xy[2] - xy[0], h: xy[3] - xy[1] };
        if (snapCard) r = fitCardRect(r);
        const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
        ctx.beginPath();
        corners.forEach(([cx, cy], c) => {
          const p = unrollPoint(cx, cy);
          if (c === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
        ctx.stroke();
        continue;
      }
      let r = mapContain(xy, imgW, imgH, overlay.width, overlay.height);
      if (snapCard) r = fitCardRect(r);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }
  }

  function drawBoxes(next, w, h, roll = 0, ow = 0, oh = 0) {
    boxes = next || null;
    imgW = w || 0;
    imgH = h || 0;
    lastRoll = Number.isFinite(roll) ? roll : 0;
    origW = ow || imgW;
    origH = oh || imgH;
    paintOverlay();
  }

  function startPulse() {
    const t0 = performance.now();
    const frame = (now) => {
      pulse = ((now - t0) % 700) / 700;
      if (boxes) paintOverlay();
      pulseRaf = requestAnimationFrame(frame);
    };
    pulseRaf = requestAnimationFrame(frame);
  }

  // ---------- tilt ----------
  function screenAngle() {
    const angle = window.screen?.orientation?.angle;
    if (Number.isFinite(angle)) return angle;
    return Number.isFinite(window.orientation) ? window.orientation : 0;
  }

  function onDeviceOrientation(event) {
    const reading = uprightRoll(event.beta, event.gamma, screenAngle());
    tiltAt = Date.now();
    if (!reading) {
      tiltReading = null;
      return;
    }
    tiltReading = reading.roll;
    // Circular EMA on the unit vector: averaging raw angles flips near ±180°.
    const rad = (reading.roll * Math.PI) / 180;
    if (tiltHave) {
      tiltX = tiltX * (1 - TILT_ALPHA) + Math.cos(rad) * TILT_ALPHA;
      tiltY = tiltY * (1 - TILT_ALPHA) + Math.sin(rad) * TILT_ALPHA;
    } else {
      tiltX = Math.cos(rad);
      tiltY = Math.sin(rad);
      tiltHave = true;
    }
  }

  function currentRoll() {
    if (tiltReading === null || Date.now() - tiltAt > TILT_STALE_MS) return 0;
    const roll = (Math.atan2(tiltY, tiltX) * 180) / Math.PI;
    if (!Number.isFinite(roll) || Math.abs(roll) < 3) return 0;
    return Math.max(-TILT_CLAMP, Math.min(TILT_CLAMP, roll));
  }

  /** iOS grants motion access only from a user gesture. */
  function requestTiltPermission() {
    if (tiltAsked) return;
    const orientation = window.DeviceOrientationEvent;
    if (!orientation || typeof orientation.requestPermission !== 'function') return;
    tiltAsked = true;
    try {
      const asked = orientation.requestPermission();
      asked?.catch?.(() => {});
    } catch (_) { /* not from a gesture */ }
  }

  // ---------- identify ----------
  function invalidate() {
    scanRevision += 1;
    requestController?.abort();
    drawBoxes(null, 0, 0);
  }

  function stopLive() {
    if (liveTimer !== null) clearTimeout(liveTimer);
    liveTimer = null;
  }

  function scheduleLive(delay = LIVE_MS) {
    if (locked || !stream || destroyed || document.hidden) return;
    if (liveTimer !== null) clearTimeout(liveTimer);
    liveTimer = setTimeout(tick, Math.max(80, delay));
  }

  async function identify(blob, info) {
    const live = Boolean(info?.live);
    const revision = scanRevision;
    const selected = catalog();
    if (!selected) return null;
    const controller = new AbortController();
    requestController?.abort();
    requestController = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const body = new FormData();
    body.append('file', blob, 'card.jpg');
    let data;
    try {
      const res = await fetch(scanIdentifyUrl({ catalog: selected, multi: mode() === 'multi', live }), {
        method: 'POST',
        body,
        signal: controller.signal,
      });
      data = await res.json().catch(() => ({}));
      if (revision !== scanRevision || (live && (info.viewVersion !== viewVersion || video.hidden))) return null;
      if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Scan request failed');
      if (data.catalog && data.catalog !== selected) throw new Error('Unexpected catalog response');
    } catch (err) {
      // A newer revision aborted this request on purpose; same revision means the timeout fired.
      if (revision === scanRevision) {
        opts.onStatus?.(err?.name === 'AbortError' ? 'Scan timed out. Please try again.' : 'Scan unavailable. Please try again.');
      }
      return null;
    } finally {
      clearTimeout(timeout);
      if (requestController === controller) requestController = null;
    }
    if (data.busy) {
      opts.onResult?.(readScanResult(data), { live });
      return data;
    }
    drawBoxes(data.boxes, data.img_w, data.img_h, info?.roll || 0, info?.frame?.w || 0, info?.frame?.h || 0);
    const result = readScanResult(data, { mode: mode(), live, gameId: opts.game?.() });
    if (result.state === 'accepted') {
      // Same as the phone scanner: an accepted Single match ends the live pass.
      locked = true;
      stopLive();
    }
    opts.onResult?.(result, { live });
    return data;
  }

  async function tick() {
    liveTimer = null;
    if (locked || !stream || video.hidden || !camReady || destroyed) return;
    if (busy) {
      scheduleLive(250);
      return;
    }
    busy = true;
    try {
      const version = viewVersion;
      const roll = currentRoll();
      const frame = frameSize(video, LIVE_MAX_SIDE) || {};
      const blob = await blobFromCanvas(video, LIVE_MAX_SIDE, 0.72, roll);
      if (!blob || version !== viewVersion) {
        scheduleLive();
        return;
      }
      const data = await identify(blob, { live: true, viewVersion: version, roll, frame });
      if (locked) return;
      scheduleLive(data?.busy ? 250 : LIVE_MS);
    } catch (_) {
      scheduleLive(500);
    } finally {
      busy = false;
    }
  }

  // ---------- camera ----------
  function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    track = null;
    camReady = false;
    torchOn = false;
  }

  async function configureTrack(active) {
    const caps = active.getCapabilities ? active.getCapabilities() : {};
    const settings = {};
    if (caps.zoom && Number.isFinite(caps.zoom.min) && Number.isFinite(caps.zoom.max)) {
      settings.zoom = Math.max(caps.zoom.min, Math.min(1, caps.zoom.max));
    }
    if (caps.focusMode?.includes?.('continuous')) settings.focusMode = 'continuous';
    if (Object.keys(settings).length) {
      try {
        await active.applyConstraints({ ...cameraConstraints(), advanced: [settings] });
      } catch (_) { /* some browsers report read-only controls */ }
    }
  }

  async function start(deviceId = '') {
    requestTiltPermission();
    if (!navigator.mediaDevices?.getUserMedia) {
      setState({ camera: 'unavailable' });
      return;
    }
    const request = ++cameraRequest;
    invalidate();
    viewVersion += 1;
    stopLive();
    stopStream();
    locked = false;
    setState({ camera: 'opening', torch: false, torchOn: false });
    let next = null;
    const stale = () => {
      if (request === cameraRequest && !destroyed) return false;
      next?.getTracks().forEach((t) => t.stop());
      return true;
    };
    try {
      const constraints = (id) => ({
        audio: false,
        video: { ...cameraConstraints(), ...(id ? { deviceId: { exact: id } } : { facingMode: { ideal: 'environment' } }) },
      });
      next = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
      if (stale()) return;
      let active = next.getVideoTracks()[0];
      let devices = [];
      try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (_) { /* labels stay empty */ }
      if (stale()) return;
      const currentId = active.getSettings?.().deviceId || '';
      const preferred = deviceId ? null : preferredCamera(devices, currentId);
      if (preferred?.deviceId && preferred.deviceId !== currentId) {
        next.getTracks().forEach((t) => t.stop());
        try { next = await navigator.mediaDevices.getUserMedia(constraints(preferred.deviceId)); } catch (_) { next = await navigator.mediaDevices.getUserMedia(constraints(currentId)); }
        active = next.getVideoTracks()[0];
      }
      if (stale()) return;
      await configureTrack(active);
      if (stale()) return;
      stream = next;
      track = active;
      video.srcObject = stream;
      video.play?.().catch?.(() => {});
      clearPhoto();
      video.hidden = false;
      camReady = true;
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      const cameras = devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
      setState({ camera: 'live', torch: Boolean(caps.torch), torchOn: false, cameras, deviceId: track.getSettings?.().deviceId || '' });
      opts.onStatus?.('Point at a card. Keep all four corners visible.');
      scheduleLive(LIVE_MS);
    } catch (error) {
      next?.getTracks().forEach((t) => t.stop());
      if (request !== cameraRequest || destroyed) return;
      setState({ camera: error?.name === 'NotAllowedError' ? 'blocked' : 'unavailable' });
    }
  }

  async function toggleTorch() {
    const caps = track?.getCapabilities?.();
    if (!caps?.torch) return;
    torchOn = !torchOn;
    try {
      await track.applyConstraints({ ...(track.getConstraints ? track.getConstraints() : cameraConstraints()), advanced: [{ torch: torchOn }] });
    } catch (_) {
      torchOn = false;
    }
    setState({ torchOn });
  }

  // ---------- photo ----------
  function clearPhoto() {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = '';
    photoSource = null;
    photo.removeAttribute('src');
    photo.hidden = true;
  }

  async function scanPhoto() {
    if (!photoSource) return;
    const source = photoSource;
    const revision = scanRevision;
    stopLive();
    opts.onStatus?.('Scanning photo…');
    const blob = await blobFromCanvas(source, PHOTO_MAX_SIDE);
    if (!blob || revision !== scanRevision) return;
    // A live frame can still be finishing on the worker when a photo arrives.
    for (let attempt = 0; attempt < PHOTO_BUSY_RETRIES; attempt += 1) {
      if (revision !== scanRevision || destroyed) return;
      const data = await identify(blob, { live: false });
      if (!data || !data.busy) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (revision === scanRevision) opts.onStatus?.('The scanner is busy. Try again shortly.');
  }

  function scanFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type || '') && !/\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(file.name || '')) {
      opts.onStatus?.('That file is not a photo. Try a JPEG or PNG.');
      return;
    }
    invalidate();
    viewVersion += 1;
    stopLive();
    locked = false;
    const revision = scanRevision;
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (revision !== scanRevision || destroyed) return;
      photoSource = img;
      photo.src = img.src;
      photo.hidden = false;
      video.hidden = true;
      setState({ camera: stream ? 'paused' : state.camera, photo: true });
      scanPhoto();
    };
    img.onerror = () => {
      if (revision !== scanRevision) return;
      opts.onStatus?.('This photo could not be opened. Try a JPEG or PNG.');
    };
    img.src = photoUrl;
  }

  /** Back to the live camera after a photo or an accepted match. */
  function resume() {
    invalidate();
    locked = false;
    clearPhoto();
    setState({ photo: false });
    if (stream) {
      video.hidden = false;
      setState({ camera: 'live' });
      opts.onStatus?.('Point at a card. Keep all four corners visible.');
      scheduleLive(100);
    } else {
      start(state.deviceId);
    }
  }

  /** Catalog or mode changed: drop stale answers and scan again. */
  function refresh() {
    invalidate();
    locked = false;
    if (photoSource) scanPhoto();
    else {
      stopLive();
      scheduleLive(100);
    }
  }

  function onVisibility() {
    if (document.hidden) stopLive();
    else scheduleLive(100);
  }

  function onVideoResize() {
    viewVersion += 1;
    if (!video.hidden) drawBoxes(null, 0, 0);
  }

  window.addEventListener('deviceorientation', onDeviceOrientation);
  window.addEventListener('resize', paintOverlay);
  document.addEventListener('visibilitychange', onVisibility);
  video.addEventListener('resize', onVideoResize);
  startPulse();

  function destroy() {
    destroyed = true;
    cameraRequest += 1;
    invalidate();
    stopLive();
    stopStream();
    clearPhoto();
    cancelAnimationFrame(pulseRaf);
    window.removeEventListener('deviceorientation', onDeviceOrientation);
    window.removeEventListener('resize', paintOverlay);
    document.removeEventListener('visibilitychange', onVisibility);
    video.removeEventListener('resize', onVideoResize);
    video.srcObject = null;
  }

  return { start, stopLive, scanFile, resume, refresh, toggleTorch, requestTiltPermission, destroy };
}
