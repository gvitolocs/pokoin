import { createMemo, createSignal, For, Match, onSettled, Show, Switch, untrack } from 'solid-js';
import { postWatchlist, readWatchlistIds, toggleWatchlist } from '@market/api.js';
import { gameIconSrc } from '@market/game.js';
import { DASHBOARD_SCAN } from '@market/punchouts.js';
import { scanCatalogId } from '@market/scan-id.js';
import {
  catalogGroups,
  gameOfCatalog,
  initialScanCatalog,
  pickCatalog,
  scanCatalogsUrl,
  scanStatusText,
} from '@market/scan-live.js';
import '@market/scan-page.css';
import { signedIn } from '../stores/auth.js';
import { createLiveCamera } from './scan/live-camera.js';
import { usePageTitle } from './tools/board.jsx';

const CATALOG_TIMEOUT_MS = 10000;

const CAMERA_TEXT = {
  idle: 'Start the camera, or drop a photo of a card.',
  opening: 'Opening camera…',
  blocked: 'Camera blocked. Allow it in your browser’s site settings, then try again.',
  unavailable: 'No camera here. Upload a photo of the card instead.',
};

function requestedCatalog() {
  try {
    return new URL(window.location.href).searchParams.get('catalog') || '';
  } catch (_) {
    return '';
  }
}

function rememberCatalog(id) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('catalog', id);
    window.history.replaceState(window.history.state, '', url);
  } catch (_) { /* URL sync is a convenience */ }
}

/** Site catalog (game path + print language) as the scanner's first catalog. */
function siteCatalog() {
  return initialScanCatalog(untrack(() => scanCatalogId()));
}

function percent(score) {
  return `${Math.round((Number(score) || 0) * 100)}%`;
}

function hitMeta(hit) {
  return [hit.set, hit.number].filter(Boolean).join(' · ');
}

function IconCamera() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.4-2h5l1.4 2h1.6A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z" />
      <circle cx="12" cy="12.5" r="3.5" />
    </svg>
  );
}

function IconPhoto() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m20.5 16-4.8-4.8L7 19.5" />
    </svg>
  );
}

function IconTorch() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M13 2 5 13.5h6L10 22l8.5-12H13z" />
    </svg>
  );
}

function IconRetry() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}

function HitRow(props) {
  return (
    <a class="scan-hit" href={props.hit.href || undefined} aria-disabled={props.hit.href ? undefined : 'true'}>
      <span class="scan-hit-art">
        <Show when={props.hit.image}>
          <img src={props.hit.image} alt="" loading="lazy" decoding="async" />
        </Show>
      </span>
      <span class="scan-hit-text">
        <strong>{props.hit.name}</strong>
        <span>{hitMeta(props.hit)}</span>
      </span>
      <span class="scan-hit-score">{percent(props.hit.score)}</span>
    </a>
  );
}

/** Live card scanner: /scan, /cardscan, /scancard. Same flow and API calls as scan.pokoin.com. */
export default function Scan() {
  usePageTitle('Scan a card · Pokoin');
  const [groups, setGroups] = createSignal([]);
  const [catalogsFailed, setCatalogsFailed] = createSignal(false);
  const [catalog, setCatalog] = createSignal(requestedCatalog() || siteCatalog());
  const [mode, setMode] = createSignal('single');
  const [camera, setCamera] = createSignal({ camera: 'idle', photo: false, torch: false, torchOn: false, cameras: [], deviceId: '' });
  const [status, setStatus] = createSignal('');
  const [result, setResult] = createSignal({ state: 'idle', hits: [] });
  const [dragging, setDragging] = createSignal(false);
  const [watched, setWatched] = createSignal(untrack(() => readWatchlistIds()));

  const game = createMemo(() => gameOfCatalog(catalog(), groups()) || String(catalog()).replace(/_[a-z]+$/, ''));
  const activeGroup = createMemo(() => groups().find((group) => group.game === game()) || null);
  const top = createMemo(() => (result().state === 'accepted' ? result().hits[0] : null));
  const live = () => camera().camera === 'live' && !camera().photo;
  const showStart = () => !camera().photo && camera().camera !== 'live' && camera().camera !== 'paused';
  const statusText = () => status() || CAMERA_TEXT[camera().camera] || '';

  let video;
  let photo;
  let overlay;
  let fileInput;
  let results;
  let engine = null;

  function selectCatalog(id) {
    if (!id || id === catalog()) return;
    setCatalog(id);
    rememberCatalog(id);
    setResult({ state: 'idle', hits: [] });
    engine?.refresh();
  }

  function selectGame(group) {
    if (group.game === game()) return;
    selectCatalog(group.catalogs[0]?.id);
  }

  function chooseMode(next) {
    if (next === mode()) return;
    setMode(next);
    setResult({ state: 'idle', hits: [] });
    engine?.refresh();
  }

  function onResult(next) {
    if (next.state === 'busy') {
      setStatus(scanStatusText('busy'));
      return;
    }
    setResult(next);
    setStatus(next.state === 'accepted' ? `Match found: ${next.hits[0].name}` : scanStatusText(next.state));
    if (next.state === 'accepted' && window.matchMedia?.('(max-width: 900px)').matches) {
      requestAnimationFrame(() => results?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    }
  }

  function scanNext() {
    setResult({ state: 'idle', hits: [] });
    setStatus('');
    engine?.resume();
  }

  function pickFile(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) {
      setResult({ state: 'idle', hits: [] });
      engine?.scanFile(file);
    }
  }

  function onDrop(event) {
    event.preventDefault();
    setDragging(false);
    const file = [...(event.dataTransfer?.files || [])].find((row) => /^image\//.test(row.type)) || event.dataTransfer?.files?.[0];
    if (file) {
      setResult({ state: 'idle', hits: [] });
      engine?.scanFile(file);
    }
  }

  function toggleWatch(hit) {
    const on = toggleWatchlist(hit.id);
    postWatchlist(hit.id, on ? 'add' : 'remove');
    setWatched(readWatchlistIds());
  }

  async function loadCatalogs() {
    try {
      const res = await fetch(scanCatalogsUrl(), { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
      if (!res.ok) throw new Error('catalogs');
      const data = await res.json();
      const next = catalogGroups(data.catalogs);
      if (!next.length) throw new Error('catalogs');
      setGroups(next);
      const picked = pickCatalog(next, { requested: requestedCatalog(), preferred: siteCatalog(), gameId: untrack(game) });
      if (picked && picked !== catalog()) {
        setCatalog(picked);
        engine?.refresh();
      }
    } catch (_) {
      setCatalogsFailed(true);
    }
  }

  onSettled(() => {
    engine = createLiveCamera({
      video,
      photo,
      overlay,
      catalog: () => catalog(),
      game: () => game(),
      mode: () => mode(),
      onResult,
      onStatus: setStatus,
      onState: (next) => {
        setCamera(next);
        if (next.camera !== 'live') setStatus('');
      },
    });
    loadCatalogs();

    // Only an already granted camera starts by itself; everyone else taps once
    // (iOS never shows the first prompt without a gesture). permissions.query
    // can hang, so the gate settles within 400 ms either way.
    let settled = false;
    const gate = (granted) => {
      if (settled) return;
      settled = true;
      if (granted) engine?.start();
    };
    const timer = setTimeout(() => gate(false), 400);
    navigator.permissions?.query?.({ name: 'camera' })
      .then((perm) => gate(perm.state === 'granted'))
      .catch(() => gate(false));

    // A photo dropped anywhere on the page scans instead of opening in the tab.
    const stopDefault = (event) => {
      if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault();
    };
    const onWindowDrop = (event) => {
      if (!event.defaultPrevented && event.dataTransfer?.files?.length) onDrop(event);
      setDragging(false);
    };
    const onPaste = (event) => {
      const file = [...(event.clipboardData?.files || [])].find((row) => /^image\//.test(row.type));
      if (file) {
        setResult({ state: 'idle', hits: [] });
        engine?.scanFile(file);
      }
    };
    window.addEventListener('dragover', stopDefault);
    window.addEventListener('drop', onWindowDrop);
    window.addEventListener('paste', onPaste);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('dragover', stopDefault);
      window.removeEventListener('drop', onWindowDrop);
      window.removeEventListener('paste', onPaste);
      engine?.destroy();
      engine = null;
    };
  });

  return (
    <div class="page scan-page">
      <header class="scan-head">
        <p class="page-kicker">Scan</p>
        <h1 class="page-title">Scan a card</h1>
        <p class="scan-lede">Point your camera at a card, or drop in a photo. Pokoin finds the exact printing.</p>
      </header>

      <nav class="scan-catalogs" aria-label="Game to scan">
        <div class="scan-games" role="group" aria-label="Game">
          <For each={groups()}>
            {(group) => (
              <button
                type="button"
                class={['scan-game', { on: group.game === game() }]}
                aria-pressed={group.game === game() ? 'true' : 'false'}
                onClick={() => selectGame(group)}
              >
                <Show when={gameIconSrc(group.game)}>
                  <span class="scan-game-icon" style={{ '-webkit-mask-image': `url(${gameIconSrc(group.game)})`, 'mask-image': `url(${gameIconSrc(group.game)})` }} aria-hidden="true" />
                </Show>
                <span>{group.name}</span>
              </button>
            )}
          </For>
          <Show when={catalogsFailed()}>
            <span class="scan-catalogs-note">Game list unavailable. Scanning with the default catalog.</span>
          </Show>
        </div>
        <Show when={(activeGroup()?.catalogs.length || 0) > 1}>
          <div class="scan-langs" role="group" aria-label="Catalog language">
            <For each={activeGroup()?.catalogs || []}>
              {(row) => (
                <button
                  type="button"
                  class={['scan-lang', { on: row.id === catalog() }]}
                  aria-pressed={row.id === catalog() ? 'true' : 'false'}
                  title={`${row.label} · ${row.count} cards`}
                  onClick={() => selectCatalog(row.id)}
                >
                  {row.label}
                </button>
              )}
            </For>
          </div>
        </Show>
      </nav>

      <div class="scan-layout">
        <section
          class={['scan-stage', { dragging: dragging(), live: live() }]}
          aria-label="Camera"
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
          onDrop={onDrop}
        >
          <video ref={(el) => { video = el; }} class="scan-video" playsinline autoplay muted hidden />
          <img ref={(el) => { photo = el; }} class="scan-photo" alt="Your photo" hidden />
          <canvas ref={(el) => { overlay = el; }} class="scan-overlay" aria-hidden="true" />
          <Show when={live()}>
            <div class="scan-guide" aria-hidden="true"><span /></div>
          </Show>

          <Show when={showStart()}>
            <div class="scan-start">
              <span class="scan-start-icon"><IconCamera /></span>
              <h2>Scan with your camera</h2>
              <p>{dragging() ? 'Drop the photo to scan it.' : 'Hold the card flat, in good light, with all four corners in view.'}</p>
              <div class="scan-start-actions">
                <Show when={camera().camera !== 'unavailable'}>
                  <button type="button" class="btn" disabled={camera().camera === 'opening'} onClick={() => engine?.start()}>
                    {camera().camera === 'blocked' ? 'Try the camera again' : (camera().camera === 'opening' ? 'Opening camera…' : 'Start camera')}
                  </button>
                </Show>
                <button type="button" class="btn ghost" onClick={() => fileInput?.click()}>Upload a photo</button>
              </div>
              <p class="scan-start-hint">You can also drop or paste a photo here.</p>
            </div>
          </Show>

          <p class={['scan-status', { quiet: !statusText() }]} role="status" aria-live="polite">{statusText()}</p>

          <div class="scan-controls">
            <div class="scan-seg" role="group" aria-label="Scan mode">
              <button type="button" class={{ on: mode() === 'single' }} aria-pressed={mode() === 'single' ? 'true' : 'false'} onClick={() => chooseMode('single')}>Single</button>
              <button type="button" class={{ on: mode() === 'multi' }} aria-pressed={mode() === 'multi' ? 'true' : 'false'} onClick={() => chooseMode('multi')}>Multi</button>
            </div>
            <Show when={camera().torch && live()}>
              <button type="button" class={['scan-icon', { on: camera().torchOn }]} aria-label="Flash" aria-pressed={camera().torchOn ? 'true' : 'false'} onClick={() => engine?.toggleTorch()}>
                <IconTorch />
              </button>
            </Show>
            <Show when={camera().photo || top()}>
              <button type="button" class="scan-icon" aria-label="Back to the camera" title="Back to the camera" onClick={scanNext}>
                <IconRetry />
              </button>
            </Show>
            <button type="button" class="scan-icon" aria-label="Upload a photo" title="Upload a photo" onClick={() => fileInput?.click()}>
              <IconPhoto />
            </button>
            <Show when={camera().cameras.length > 1 && live()}>
              <select class="scan-camera-select" aria-label="Camera" value={camera().deviceId} onChange={(event) => engine?.start(event.currentTarget.value)}>
                <For each={camera().cameras}>
                  {(row) => <option value={row.id}>{row.label}</option>}
                </For>
              </select>
            </Show>
          </div>
          <input ref={(el) => { fileInput = el; }} class="scan-file" type="file" accept="image/*" onChange={pickFile} />
        </section>

        <aside class="scan-side" ref={(el) => { results = el; }}>
          <section class="scan-panel scan-results" aria-label="Scan results">
            <Switch fallback={(
              <div class="scan-empty">
                <h2>Results</h2>
                <p>The card appears here as soon as it is recognised.</p>
                <ul>
                  <li>Pick the game first. Pokémon also has Japanese and Chinese catalogs.</li>
                  <li>Multi finds several cards in one frame.</li>
                  <li>Sleeves and toploaders are fine. Avoid glare.</li>
                </ul>
              </div>
            )}>
              <Match when={top()}>
                {(hit) => (
                  <div class="scan-match">
                    <a class="scan-match-art" href={hit().href}>
                      <Show when={hit().image}>
                        <img src={hit().image} alt={hit().name} decoding="async" />
                      </Show>
                    </a>
                    <div class="scan-match-text">
                      <p class="scan-match-score">{percent(hit().score)} match</p>
                      <h2>{hit().name}</h2>
                      <p class="scan-match-meta">{hitMeta(hit())}</p>
                      <div class="scan-match-actions">
                        <a class="btn" href={hit().href}>Open card</a>
                        <button type="button" class="btn ghost" aria-pressed={watched().includes(hit().id) ? 'true' : 'false'} onClick={() => toggleWatch(hit())}>
                          {watched().includes(hit().id) ? 'Watching' : 'Watch'}
                        </button>
                        <button type="button" class="btn ghost" onClick={scanNext}>Scan next</button>
                      </div>
                    </div>
                  </div>
                )}
              </Match>
              <Match when={result().hits.length}>
                <div class="scan-list">
                  <h2>{result().state === 'multi' ? `${result().hits.length} card${result().hits.length === 1 ? '' : 's'} found` : 'Possible matches'}</h2>
                  <For each={result().hits}>
                    {(hit) => <HitRow hit={hit} />}
                  </For>
                </div>
              </Match>
            </Switch>
          </section>

          <section class="scan-panel scan-save" aria-label="Save scans">
            <Show
              when={signedIn()}
              fallback={(
                <>
                  <h2>Save what you scan</h2>
                  <p>Scanning is free. Sign in to add cards to your collection or list them for sale.</p>
                  <a class="btn ghost" href={`/auth?from=${encodeURIComponent('/scan')}`}>Sign in</a>
                </>
              )}
            >
              <h2>Scan a whole pile</h2>
              <p>Pair your phone with the scan desk to add a stack of cards to your collection or list them for sale.</p>
              <a class="btn ghost" href={DASHBOARD_SCAN}>Open the scan desk</a>
            </Show>
          </section>
        </aside>
      </div>
    </div>
  );
}
