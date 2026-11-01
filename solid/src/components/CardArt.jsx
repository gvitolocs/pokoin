import { createEffect, createMemo, createSignal, onCleanup, onSettled, Show } from 'solid-js';
import { artCutFor, artCutVars } from '@market/art-cut.js';
import { artworkFigureMaskSrc, figureOrigin, loadFigureBox } from '@market/art-figure-mask.js';
import { cardReference, writeListingDrag } from '@market/chat-listing.js';
import { DEAD_IMAGE, rememberImageFallback, workingImage } from '@market/image-fallback-memo.js';
import { cdnFetchUrl, rasterSiblings } from '@market/image-urls.js';
import { heroOpen, onHeroGate } from '@market/hero-gate.js';
import { isCardTraderPlaceholderSize, MISSING_CARD_RETRY_MS, MISSING_CARD_SRC, retryImageUrl } from '@market/missing-card.js';
import { langScanLanguage, langScanUrl } from '@market/lang-scans.js';
import { searchLang } from '../stores/locale.js';

function artDebugEnabled() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('pokoinDebugArt') === '1';
  } catch {
    return false;
  }
}

function logCardArt(event, detail) {
  if (typeof console === 'undefined' || typeof console.warn !== 'function') return;
  if (event !== 'error' && event !== 'retry' && event !== 'dead' && event !== 'placeholder' && !artDebugEnabled()) return;
  console.warn('[pokoin:card-art]', event, detail);
}

/**
 * Card scan with CDN sibling fallback:
 * each failed URL, or a CardTrader grey placeholder size, steps to the next
 * raster sibling; when the last one fails the list is fetched once more
 * (`r=1`, after MISSING_CARD_RETRY_MS), then the Pokoin missing-card scan.
 * Only the <img> src changes on a fallback — nothing else re-renders.
 *
 * `langScans` (a card row's `langScans`) puts the TCGdex scan in the picked
 * card language first (market/src/lang-scans.js); the leftover scan is its
 * fallback. Crops (`cut`) keep the leftover: their windows are measured on it.
 */
export default function CardArt(props) {
  const langSrc = () => (props.cut ? '' : langScanUrl(props.langScans, searchLang()));
  const urls = createMemo(
    () => [langSrc(), ...rasterSiblings(props.src, { full: Boolean(props.full) }).map(cdnFetchUrl)].filter(Boolean),
    { equals: (a, b) => a.length === b.length && a.every((u, i) => u === b[i]) },
  );
  // Writable derived state: both reset whenever the sibling list changes.
  // A sibling that loaded here before is tried first, so a revisit never
  // repaints through the failing ones (.jpg → .png → .webp).
  const firstIndex = (list) => Math.max(0, list.indexOf(workingImage(list[0])));

  const [index, setIndex] = createSignal(() => firstIndex(urls()));
  // All siblings failed here before, retry round included: the missing-card scan at once.
  const [dead, setDead] = createSignal(() => workingImage(urls()[0]) === DEAD_IMAGE);
  // 0 on the first pass, 1 on the retry round. Memo keys stay un-busted.
  const [retry, setRetry] = createSignal(() => (urls(), 0));
  const current = () => urls()[index()] || '';
  const shown = () => retryImageUrl(current(), retry());
  const cardId = () => props.card?.id || props.card?.card_id || '';
  let errorSent = false;
  let img;
  let retryTimer = 0;
  const clearRetry = () => {
    clearTimeout(retryTimer);
    retryTimer = 0;
  };
  onCleanup(clearRetry);
  // Thumbnails wait while a desk hero loads (market/src/hero-gate.js); full
  // scans never do.
  const [gateOpen, setGateOpen] = createSignal(heroOpen());
  onSettled(() => {
    const stop = onHeroGate(setGateOpen);
    setGateOpen(heroOpen());
    return stop;
  });

  function failCurrent({ retryable = true } = {}) {
    const list = urls();
    const at = index();
    const next = at + 1;
    if (next < list.length) {
      logCardArt('error', { full: props.full, cardId: cardId(), failed: list[at], next: list[next], siblings: list });
      setIndex(next);
      return;
    }
    // One dropped request or a slow origin is not a missing scan: walk the
    // list once more before the missing-card scan is shown and remembered.
    if (retryable && !retry()) {
      if (retryTimer) return;
      logCardArt('retry', { full: props.full, cardId: cardId(), failed: list[at], inMs: MISSING_CARD_RETRY_MS });
      retryTimer = setTimeout(() => {
        retryTimer = 0;
        if (urls() !== list) return;
        setIndex(0);
        setRetry(1);
      }, MISSING_CARD_RETRY_MS);
      return;
    }
    clearRetry();
    setDead(true);
    rememberImageFallback(list[0], DEAD_IMAGE, { keepMs: 6 * 60 * 60_000 });
    logCardArt('dead', { full: props.full, cardId: cardId(), src: props.src, siblings: list });
    if (!errorSent) {
      errorSent = true;
      props.onError?.();
    }
  }

  function acceptIfScan(node) {
    if (!node || !node.complete || node.naturalWidth <= 0) return;
    if (isCardTraderPlaceholderSize(node.naturalWidth, node.naturalHeight)) {
      logCardArt('placeholder', { full: props.full, cardId: cardId(), src: node.currentSrc, natural: `${node.naturalWidth}x${node.naturalHeight}` });
      // A real placeholder file: fetching it again would not help.
      failCurrent({ retryable: false });
      return;
    }
    if (index() > 0) rememberImageFallback(urls()[0], current());
    if (props.full) {
      logCardArt('load', { cardId: cardId(), src: node.currentSrc, natural: `${node.naturalWidth}x${node.naturalHeight}` });
    }
    props.onLoad?.(node);
  }

  // A new sibling list starts its own first pass.
  createEffect(urls, clearRetry);

  createEffect(() => urls().length, (length) => {
    if (length || errorSent) return;
    errorSent = true;
    logCardArt('dead', { full: props.full, cardId: cardId(), src: props.src, reason: 'empty-siblings' });
    props.onError?.();
  });

  // A memo, not a getter: onSettled below may not create primitives, and
  // reading a compiled prop getter there would.
  const figureMask = createMemo(() => props.figureMask
    ?? (props.cut && props.cutSurface === 'album' ? artworkFigureMaskSrc(props.card) : ''));
  const [showFigure, setShowFigure] = createSignal(false);
  const [figurePhase, setFigurePhase] = createSignal('in');
  const [figureHit, setFigureHit] = createSignal(null);
  const figureOriginStyle = createMemo(() => {
    const mask = figureMask();
    const hit = figureHit();
    if (!hit || hit.mask !== mask || !hit.box) return {};
    const origin = figureOrigin(hit.box, artCutFor(props.card, props.cutSurface));
    return {
      '--figure-cx': String(origin.x),
      '--figure-cy': String(origin.y),
    };
  });
  const figureHoverStyle = createMemo(() => ({
    '--art-figure-mask': `url("${cdnFetchUrl(figureMask())}")`,
    ...figureOriginStyle(),
  }));
  onSettled(() => {
    const node = img?.closest('.tile');
    if (!node || !figureMask()) return undefined;
    // CSS exit is 200ms. The margin lets the scale land on the painting
    // before the layers unmount.
    const exitMs = 230;
    let exitTimer = 0;
    let exitGen = 0;
    const reducedMotion = () => {
      try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch {
        return false;
      }
    };
    const enter = () => {
      exitGen += 1;
      window.clearTimeout(exitTimer);
      exitTimer = 0;
      setFigurePhase('in');
      setShowFigure(true);
      const mask = figureMask();
      loadFigureBox(cdnFetchUrl(mask)).then((box) => {
        if (figureMask() !== mask) return;
        setFigureHit({ mask, box });
      });
    };
    const leave = () => {
      exitGen += 1;
      window.clearTimeout(exitTimer);
      exitTimer = 0;
      if (reducedMotion()) {
        setShowFigure(false);
        return;
      }
      const gen = exitGen;
      setFigurePhase('out');
      exitTimer = window.setTimeout(() => {
        exitTimer = 0;
        if (gen !== exitGen) return;
        setShowFigure(false);
      }, exitMs);
    };
    const onFocusOut = (event) => {
      const next = event.relatedTarget;
      if (next && node.contains(next)) return;
      leave();
    };
    node.addEventListener('pointerenter', enter);
    node.addEventListener('pointerleave', leave);
    node.addEventListener('focusin', enter);
    node.addEventListener('focusout', onFocusOut);
    return () => {
      exitGen += 1;
      window.clearTimeout(exitTimer);
      node.removeEventListener('pointerenter', enter);
      node.removeEventListener('pointerleave', leave);
      node.removeEventListener('focusin', enter);
      node.removeEventListener('focusout', onFocusOut);
    };
  });

  const placeholder = () => (
    <img
      class={['missing-card', props.class]}
      src={MISSING_CARD_SRC}
      alt={props.alt || ''}
      width="630"
      height="880"
      draggable="false"
      onClick={(event) => props.onClick?.(event)}
    />
  );

  const image = () => (
    <img
      ref={(node) => { img = node; }}
      class={[props.class, { 'is-lang-scan': Boolean(langScanLanguage(current())) }]}
      alt={props.alt || ''}
      loading={props.loading}
      fetchpriority={props.fetchPriority}
      decoding={props.full ? 'sync' : 'async'}
      // src last, like React DOM does for <img>: loading / decoding /
      // fetchpriority must be on the element before the URL is.
      src={props.full || gateOpen() ? shown() : undefined}
      // Enumerated attribute, not boolean: "false" stops the native image ghost.
      draggable={props.dragCard ? 'true' : 'false'}
      onClick={(event) => props.onClick?.(event)}
      onLoad={(event) => acceptIfScan(event.currentTarget)}
      onError={() => failCurrent()}
      onDragStart={(event) => {
        const card = props.dragCard;
        if (!card) return;
        writeListingDrag(event, card.kind && card.cardName ? card : cardReference(card));
      }}
    />
  );

  return (
    <Show
      when={current() && !dead()}
      fallback={(
        <Show when={props.fallback !== 'hide'}>
          <Show when={props.cut} fallback={placeholder()}>
            <span class="art-cut" style={artCutVars(props.card, props.cutSurface)}>{placeholder()}</span>
          </Show>
        </Show>
      )}
    >
      <Show when={props.cut} fallback={image()}>
        <span class="art-cut" style={artCutVars(props.card, props.cutSurface)}>
          {image()}
          <Show when={figureMask() && showFigure()}>
            <img
              class="art-figure-layer art-figure-shadow"
              data-figure={figurePhase()}
              src={cdnFetchUrl(figureMask())}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              style={figureOriginStyle()}
            />
            <img
              class="art-figure-layer art-figure-hover"
              data-figure={figurePhase()}
              src={shown()}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              style={figureHoverStyle()}
            />
          </Show>
        </span>
      </Show>
    </Show>
  );
}
