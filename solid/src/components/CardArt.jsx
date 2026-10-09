import { createEffect, createMemo, createSignal, onSettled, Show } from 'solid-js';
import { artCutVars } from '@market/art-cut.js';
import { artworkFigureMaskSrc } from '@market/art-figure-mask.js';
import { cardReference, writeListingDrag } from '@market/chat-listing.js';
import { cdnFetchUrl, rasterSiblings } from '@market/image-urls.js';
import { isCardTraderPlaceholderSize, MISSING_CARD_SRC } from '@market/missing-card.js';

function artDebugEnabled() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('pokoinDebugArt') === '1';
  } catch {
    return false;
  }
}

function logCardArt(event, detail) {
  if (typeof console === 'undefined' || typeof console.warn !== 'function') return;
  if (event !== 'error' && event !== 'dead' && event !== 'placeholder' && !artDebugEnabled()) return;
  console.warn('[pokoin:card-art]', event, detail);
}

/**
 * Card scan with CDN sibling fallback (market/src/components/CardArt.jsx):
 * each failed URL, or a CardTrader grey placeholder size, steps to the next
 * raster sibling, then the Pokoin missing-card scan. Only the <img> src
 * changes on a fallback — nothing else re-renders.
 */
export default function CardArt(props) {
  const urls = createMemo(() => rasterSiblings(props.src, { full: Boolean(props.full) }).map(cdnFetchUrl).filter(Boolean));
  // Writable derived state: both reset whenever the sibling list changes.
  const [index, setIndex] = createSignal(() => (urls(), 0));
  const [dead, setDead] = createSignal(() => (urls(), false));
  const current = () => urls()[index()] || '';
  const cardId = () => props.card?.id || props.card?.card_id || '';
  let errorSent = false;
  let img;

  function failCurrent() {
    const list = urls();
    const at = index();
    const next = at + 1;
    if (next < list.length) {
      logCardArt('error', { full: props.full, cardId: cardId(), failed: list[at], next: list[next], siblings: list });
      setIndex(next);
      return;
    }
    setDead(true);
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
      failCurrent();
      return;
    }
    if (props.full) {
      logCardArt('load', { cardId: cardId(), src: node.currentSrc, natural: `${node.naturalWidth}x${node.naturalHeight}` });
    }
    props.onLoad?.(node);
  }

  createEffect(() => urls().length, (length) => {
    if (length || errorSent) return;
    errorSent = true;
    logCardArt('dead', { full: props.full, cardId: cardId(), src: props.src, reason: 'empty-siblings' });
    props.onError?.();
  });

  const figureMask = () => props.figureMask
    ?? (props.cut && props.cutSurface === 'album' ? artworkFigureMaskSrc(props.card) : '');
  const [showFigure, setShowFigure] = createSignal(false);
  onSettled(() => {
    const node = img?.closest('.tile');
    if (!node || !figureMask()) return undefined;
    const on = () => setShowFigure(true);
    const off = () => setShowFigure(false);
    node.addEventListener('pointerenter', on);
    node.addEventListener('pointerleave', off);
    node.addEventListener('focusin', on);
    node.addEventListener('focusout', off);
    return () => {
      node.removeEventListener('pointerenter', on);
      node.removeEventListener('pointerleave', off);
      node.removeEventListener('focusin', on);
      node.removeEventListener('focusout', off);
    };
  });

  const placeholder = () => (
    <img
      class={['missing-card', props.class]}
      src={MISSING_CARD_SRC}
      alt={props.alt || ''}
      width="630"
      height="880"
      onClick={(event) => props.onClick?.(event)}
    />
  );

  const image = () => (
    <img
      ref={(node) => { img = node; }}
      class={props.class}
      src={current()}
      alt={props.alt || ''}
      loading={props.loading}
      fetchpriority={props.fetchPriority}
      decoding={props.full ? 'sync' : 'async'}
      // Enumerated attribute, not boolean: "false" stops the native image ghost.
      draggable={props.dragCard ? 'true' : 'false'}
      onClick={(event) => props.onClick?.(event)}
      onLoad={(event) => acceptIfScan(event.currentTarget)}
      onError={failCurrent}
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
              src={cdnFetchUrl(figureMask())}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
            />
            <img
              class="art-figure-layer art-figure-hover"
              src={current()}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              style={{ '--art-figure-mask': `url("${cdnFetchUrl(figureMask())}")` }}
            />
          </Show>
        </span>
      </Show>
    </Show>
  );
}
