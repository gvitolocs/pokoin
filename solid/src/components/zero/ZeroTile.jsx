import { For, Show } from 'solid-js';
import { inventoryListingHref } from '@market/inventory-listings.js';
import { conditionChipSrc, conditionShort, conditionTone, listingLanguageFlag } from '@market/listing-meta.js';
import {
  alsoInLabels,
  lineCopies,
  lineFacets,
  lineKeyOf,
  lineLocation,
  lineLocationFromPt,
  lineQuantity,
  lineSetText,
  locationTakeText,
  rarityBadge,
} from '@market/zero-pick.js';
import ScanImage from '../ScanImage.jsx';
import { IssueBadge, lineImage, linePrice, PtPlace } from './zero-bits.jsx';

function PinIcon() {
  return (
    <svg class="zero-pin" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" fill="currentColor" />
    </svg>
  );
}

function CommentIcon(props) {
  return (
    <span class="zero-comment" title={props.text} aria-label={`Comment: ${props.text}`}>
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
      </svg>
    </span>
  );
}

/** Reverse / foil / 1st ed. / signed / altered / graded (condition and language are drawn as chips). */
function extraFacets(line) {
  return lineFacets({ ...line, condition: '', language: '' });
}

/**
 * One picking tile in Power Tools' "Images vertical" layout (or, with
 * `horizontal`, art left / details right). Without `onPick` it is read-only
 * (the "waiting for the next merge" list).
 */
export default function ZeroTile(props) {
  const item = () => props.item;
  const quantity = () => lineQuantity(item());
  const pick = () => props.pick || { picked: Number(item().picked) || 0, issue: item().issue || null };
  const done = () => Boolean(props.done);
  const src = () => lineImage(item());
  const interactive = () => Boolean(props.onPick);
  const rarity = () => rarityBadge(item().rarity);
  const flag = () => (item().language ? listingLanguageFlag(item().language) : null);
  const copies = () => lineCopies(item());
  const also = () => alsoInLabels(item());
  const choose = () => interactive() && props.smartLocations === false && copies().length > 0 && !done();
  const comment = () => String(item().comment || '').trim();
  return (
    <article
      class={['zero-card', 'zero-tile', {
        'is-horizontal': Boolean(props.horizontal),
        'is-picked': done(),
        'is-draggable': interactive(),
        'has-issue': Boolean(pick().issue),
        'is-match': Boolean(props.match),
        'is-current': Boolean(props.current),
      }]}
      draggable="false"
      data-zero-line={interactive() ? lineKeyOf(item()) : undefined}
      onPointerDown={(event) => {
        if (!interactive() || props.busy) return;
        props.onPointerDown?.(event, { lineKey: lineKeyOf(item()), image: src(), label: item().name || '' });
      }}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
    >
      <header class="zero-tile-head">
        <strong class="zero-tile-name thread-title">
          <Show when={item().cardId} fallback={item().name}>
            <a href={inventoryListingHref(item())} draggable="false">{item().name}</a>
          </Show>
        </strong>
        <Show when={item().nameEn}><span class="thread-meta">{item().nameEn}</span></Show>
        <Show when={lineSetText(item())}><span class="zero-tile-set thread-meta">{lineSetText(item())}</span></Show>
      </header>
      <div class="zero-card-art">
        <ScanImage src={src()} label={item().name} letterClass="zero-card-fallback" width="126" height="176" />
        <Show when={props.place != null}>
          <span class="zero-place" title="Place in this pack, in picking order">{props.place}</span>
        </Show>
        <Show when={quantity() > 1}><span class="zero-qty">take {quantity()}</span></Show>
        <Show when={done()}>
          <span class="zero-card-check" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="36" height="36">
              <path d="M5 12.5 10 17l9-10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
        </Show>
      </div>
      <div class="zero-card-body">
        <div class="zero-tile-money">
          <Show when={linePrice(item())}><span class="zero-card-price">{linePrice(item())}</span></Show>
          <Show when={item().powerTools?.bin}><span class="zero-bin" title="Order bin">Bin {item().powerTools.bin}</span></Show>
        </div>
        <span class="zero-picked-count">Picked: {pick().picked}/{quantity()}</span>
        <div class="zero-tile-badges">
          <Show when={rarity()}>
            {(badge) => <span class="zero-rarity" title={badge().long}><b>{badge().short}</b> {badge().long}</span>}
          </Show>
          <Show when={flag()}>
            {(lang) => <img class="inv-flag" src={lang().src} alt={lang().label} title={lang().label} width="18" height="18" loading="lazy" />}
          </Show>
          <Show when={item().condition}>
            <img
              class={['shop-cond', `is-${conditionTone(item().condition)}`]}
              src={conditionChipSrc(item().condition)}
              alt={conditionShort(item().condition)}
              title={item().condition}
              width="34"
              height="24"
              loading="lazy"
            />
          </Show>
          <For each={extraFacets(item())}>{(facet) => <span class="zero-facet">{facet}</span>}</For>
          <PtPlace item={item()} />
          <IssueBadge issue={pick().issue} />
          <Show when={comment()}><CommentIcon text={comment()} /></Show>
        </div>
        <span
          class={['zero-tile-loc', { 'is-empty': !lineLocation(item()) }]}
          title={lineLocationFromPt(item()) ? 'Location from Power Tools' : 'MyPokoin location'}
        >
          <PinIcon />
          {locationTakeText(item())}
          <Show when={lineLocationFromPt(item())}><small class="zero-pt-tag"> PT</small></Show>
        </span>
        <Show when={Number(item().itemQuantity) > quantity()}>
          <span class="zero-split" title="This CardTrader line is split over several places">{quantity()} of {item().itemQuantity}</span>
        </Show>
        <Show when={also().length && !choose()}>
          <span class="zero-also">also in: {also().join(', ')}</span>
        </Show>
        <Show when={props.note}><span class="zero-inventory-note" role="status">{props.note}</span></Show>
        <Show when={props.error}><span class="zero-save-error" role="alert">{props.error}</span></Show>
      </div>
      <Show when={interactive()}>
        <div class="zero-card-actions">
          <Show when={choose()}>
            <div class="zero-box-choice" role="group" aria-label="Pick from box">
              <span class="thread-meta">Pick from:</span>
              <button class="btn ghost" type="button" disabled={props.busy} onClick={() => props.onPick(item())}>
                {lineLocation(item()) || 'No location'}
              </button>
              <For each={copies()}>
                {(copy) => (
                  <button class="btn ghost" type="button" disabled={props.busy} onClick={() => props.onPick(item(), copy.listingId)}>
                    {copy.location || 'No location'}
                    <Show when={copy.quantityAvailable != null}> ({copy.quantityAvailable})</Show>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={!choose()}>
            <button
              class={['btn', 'zero-pick-main', { ghost: done(), stripe: !done() }]}
              type="button"
              draggable="false"
              disabled={props.busy}
              aria-pressed={done() ? 'true' : 'false'}
              onClick={() => (done() ? props.onUndo(item()) : props.onPick(item()))}
            >
              {props.busy ? 'Saving…' : done() ? 'Undo' : 'Pick'}
            </button>
          </Show>
          <Show when={!done() && copies().length && !choose()}>
            <button class="zero-issue-link" type="button" disabled={props.busy} onClick={() => props.onSwap(item())}>
              Picked from another box…
            </button>
          </Show>
          <Show
            when={pick().issue}
            fallback={<button class="btn ghost zero-report" type="button" onClick={() => props.onIssue(item())}>Report issue</button>}
          >
            <button class="btn ghost zero-report" type="button" onClick={() => props.onClearIssue(item())}>Clear issue</button>
          </Show>
        </div>
      </Show>
    </article>
  );
}
