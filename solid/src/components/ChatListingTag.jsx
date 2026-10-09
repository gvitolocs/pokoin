import { createEffect, createMemo, createSignal, Show } from 'solid-js';
import { fetchCard, fetchListings, imageSrc } from '@market/api.js';
import { setChatTagStock } from '@market/chat-dock-store.js';
import {
  bundleOf,
  cardIdOf,
  chatImageSources,
  chatQty,
  isSellerCard,
  listedCopies,
  overListingStock,
  paintOwned,
  personListsCard,
  tagKey,
  writeCardOwned,
} from '@market/chat-listing.js';
import { fetchCardTiles } from '@market/lists.js';
import { CHAT_ZOOM_MAX_HEIGHT } from '@market/scan-thumb-zoom.js';
import { endTrayDrag, startTrayDrag } from '@market/tray-drag.js';
import ChatBundle from './ChatBundle.jsx';
import QtyStepper from './QtyStepper.jsx';
import ThumbZoom from './ThumbZoom.jsx';

function unique(list) {
  const out = [];
  for (const item of list) {
    const value = String(item || '').trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

function urlsFromCard(card) {
  if (!card) return [];
  return unique([
    card.homepageImageUrl,
    card.tileImageUrl,
    card.homepage_image_url,
    card.heroImageUrl,
    card.imageUrl,
    card.gridImageUrl,
    card.image_url,
    imageSrc(card, 'grid'),
    imageSrc(card, 'hero'),
  ]);
}

/** Tiles miss some printings (Ancient Origins Meowth 219916). The card page still has the scan. */
async function loadCatalogImages(id) {
  const tiles = await fetchCardTiles([id]).catch(() => []);
  const tile = (tiles || []).find((item) => String(item?.id) === id) || tiles?.[0];
  const fromTiles = urlsFromCard(tile);
  if (fromTiles.length) return fromTiles;
  const page = await fetchCard(id).catch(() => null);
  return urlsFromCard(page?.card);
}

function CardQuantity(props) {
  return (
    <Show
      when={props.draft}
      fallback={(
        <Show when={!(props.row?.qty == null || props.row.qty === '')}>
          <span class="chat-qty-badge">{chatQty(props.row?.qty)}</span>
        </Show>
      )}
    >
      <QtyStepper qty={chatQty(props.row?.qty)} max={99} onChange={(next) => props.onQty?.(tagKey(props.row), next)} />
    </Show>
  );
}

function CardTag(props) {
  const row = () => props.row;
  const label = () => row().cardName || 'Card';
  const id = () => cardIdOf(row());
  const people = () => [
    { uid: props.peer?.uid || '', username: props.peer?.username || '' },
    { uid: props.me?.uid || '', username: props.me?.username || '' },
  ];
  // Everything that names "this tag": a new card, seller or scan starts over.
  const identity = createMemo(() => [
    row().imageUrl || '', id(), row().sellerUid || '', row().seller || '',
    props.peer?.uid || '', props.peer?.username || '', props.me?.uid || '', props.me?.username || '',
  ].join('|'));
  const [step, setStep] = createSignal(() => (identity(), 0));
  const [catalog, setCatalog] = createSignal(() => (identity(), []));
  const [failed, setFailed] = createSignal(() => (identity(), false));
  const [painted, setPainted] = createSignal(() => (identity(), false));
  const [owned, setOwned] = createSignal(() => (identity(), paintOwned(row(), id(), people())));

  createEffect(
    () => [id(), identity()],
    ([cardId]) => {
      if (!cardId) return undefined;
      let live = true;
      const tag = row();
      const who = people();
      loadCatalogImages(cardId).then((next) => {
        if (live && next.length) setCatalog(next);
      }).catch(() => {});
      const sellers = [
        { uid: tag.sellerUid, username: tag.seller },
        { uid: props.peer?.uid || '', username: props.peer?.username || '' },
      ];
      fetchListings(cardId).then((data) => {
        if (!live) return;
        const copies = listedCopies(data?.listings, sellers, tag.listingId);
        if (copies) setChatTagStock(tagKey(tag), copies);
        if (!isSellerCard(tag)) {
          const next = personListsCard(data?.listings, who) ? 'yes' : 'no';
          writeCardOwned(cardId, who, next);
          setOwned(next);
        }
      }).catch(() => {});
      return () => {
        live = false;
      };
    },
  );

  const list = createMemo(() => unique([...chatImageSources(row()), ...catalog()]));
  // A broken scan falls through to the first catalogue image once that list lands.
  createEffect(
    () => [catalog().join('|'), painted(), failed(), step(), list()],
    ([catalogKey, isPainted, isFailed, at, urls]) => {
      if (!catalogKey || !isFailed) return;
      const first = urls.findIndex((item) => catalog().includes(item));
      if (first < 0) return;
      if ((!isPainted || isFailed) && at !== first) setStep(first);
    },
  );

  const src = () => list()[Math.min(step(), Math.max(list().length - 1, 0))] || '';
  const full = () => list().find((url) => /\.jpe?g(?:\?|$)/i.test(url)) || list()[list().length - 1] || src();

  function onError() {
    if (step() + 1 < list().length) setStep(step() + 1);
    else setFailed(true);
  }

  const draft = () => Boolean(props.onRemove);
  const canDragOut = () => draft() && Boolean(props.trayId);
  const image = () => (
    <Show when={src()} fallback={<span class="chat-tag-ph" />}>
      <ThumbZoom src={full()} full alt={label()} maxHeight={CHAT_ZOOM_MAX_HEIGHT}>
        <img
          src={src()}
          alt=""
          draggable="false"
          onError={onError}
          onLoad={(event) => {
            const img = event.currentTarget;
            if (img.naturalWidth > 0 && img.naturalWidth < 24) onError();
            else setPainted(true);
          }}
        />
      </ThumbZoom>
    </Show>
  );

  return (
    <span
      class={['chat-tag', { 'is-trade': owned() === 'no', 'is-overstock': overListingStock(row().qty, row().stock) }]}
      draggable={canDragOut() ? 'true' : 'false'}
      onDragStart={(event) => {
        if (!canDragOut()) return;
        event.stopPropagation();
        const tag = row();
        startTrayDrag(event, { tray: props.trayId, reference: tag, remove: () => props.onRemove(tagKey(tag)) });
      }}
      onDragEnd={() => {
        if (canDragOut()) endTrayDrag();
      }}
    >
      <Show
        when={row().path}
        fallback={<span class="chat-tag-body" role="img" aria-label={label()}>{image()}</span>}
      >
        <a href={row().path} aria-label={label()} draggable="false" onClick={(event) => event.stopPropagation()}>{image()}</a>
      </Show>
      <CardQuantity row={row()} draft={draft()} onQty={props.onQty} />
      <Show when={props.onRemove}>
        <button type="button" aria-label={`Remove ${label()}`} onClick={() => props.onRemove(tagKey(row()))}>×</button>
      </Show>
    </span>
  );
}

/** A card, listing or bundle attached to a chat message or draft (market/src/components/ChatListingTag.jsx). */
export default function ChatListingTag(props) {
  return (
    <Show
      when={bundleOf(props.row)}
      fallback={(
        <CardTag
          row={props.row}
          onRemove={props.onRemove}
          onQty={props.onQty}
          peer={props.peer}
          me={props.me}
          trayId={props.trayId}
        />
      )}
    >
      <ChatBundle row={props.row} peer={props.peer} onRemove={props.onRemove} trayId={props.trayId} />
    </Show>
  );
}
