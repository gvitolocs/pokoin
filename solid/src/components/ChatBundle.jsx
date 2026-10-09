import { createEffect, createSignal, For, Show } from 'solid-js';
import { fetchArtist, fetchExpansionCards, fetchSellerShop, imageSrc } from '@market/api.js';
import { bundleOf, tagKey } from '@market/chat-listing.js';
import { fetchSpeciesCards } from '@market/species-cards.js';
import { endTrayDrag, startTrayDrag } from '@market/tray-drag.js';

function cardId(card) {
  return String(card?.id || card?.card_id || '');
}

function cardImage(card) {
  return card?.homepageImageUrl
    || card?.gridImageUrl
    || card?.imageUrl
    || card?.image_url
    || card?.cdn_image_url
    || imageSrc(card, 'grid')
    || '';
}

async function sellerCardIds(username) {
  const handle = String(username || '').trim();
  if (!handle) return new Set();
  const ids = new Set();
  let offset = 0;
  let total = Infinity;
  for (let page = 0; page < 20 && offset < total; page += 1) {
    const data = await fetchSellerShop(handle, { limit: 100, offset });
    total = Number(data?.total || 0);
    const rows = data?.listings || [];
    for (const row of rows) {
      const id = String(row?.cardId || row?.card_id || '');
      if (id) ids.add(id);
    }
    if (!rows.length) break;
    offset += rows.length;
  }
  return ids;
}

/** A whole artist / Pokémon / set dropped into a chat (market/src/components/ChatBundle.jsx). */
export default function ChatBundle(props) {
  const bundle = () => bundleOf(props.row);
  const [cards, setCards] = createSignal([]);
  const [listed, setListed] = createSignal(new Set());
  const [ready, setReady] = createSignal(false);

  createEffect(
    () => [bundle()?.kind, bundle()?.slug, props.peer?.username],
    ([kind, slug, handle]) => {
      if (!slug) return undefined;
      let live = true;
      const cardsPromise = kind === 'artist'
        ? fetchArtist(slug, { limit: 240 }).then((data) => data?.cards || [])
        : kind === 'species'
          ? fetchSpeciesCards(slug)
          : fetchExpansionCards({ slug }).then((data) => data?.cards || []);
      cardsPromise.then((rows) => {
        if (live) setCards(rows);
      }).catch(() => {});
      if (!handle) {
        setReady(true);
        return () => {
          live = false;
        };
      }
      sellerCardIds(handle).then((ids) => {
        if (!live) return;
        setListed(ids);
        setReady(true);
      }).catch(() => {
        if (live) setReady(true);
      });
      return () => {
        live = false;
      };
    },
  );

  const label = () => props.row?.cardName
    || (bundle()?.kind === 'artist' ? 'Artist' : bundle()?.kind === 'species' ? 'Pokémon' : 'Set');
  const canDragOut = () => Boolean(props.onRemove && props.trayId);

  return (
    <Show when={bundle()}>
      <span
        class="chat-bundle"
        draggable={canDragOut() ? 'true' : 'false'}
        onDragStart={(event) => {
          if (!canDragOut()) return;
          event.stopPropagation();
          const row = props.row;
          startTrayDrag(event, { tray: props.trayId, reference: row, remove: () => props.onRemove(tagKey(row)) });
        }}
        onDragEnd={() => {
          if (canDragOut()) endTrayDrag();
        }}
      >
        <span class="chat-bundle-head">
          <strong>{label()}</strong>
          <Show when={props.onRemove}>
            <button type="button" aria-label={`Remove ${label()}`} onClick={() => props.onRemove(tagKey(props.row))}>×</button>
          </Show>
        </span>
        <span class="chat-bundle-grid" aria-label={`${label()} cards`}>
          <For each={cards()}>
            {(card) => {
              const id = cardId(card);
              const src = cardImage(card);
              const href = card.canonicalPath || card.canonical_path || (id ? `/marketplace/en/cards/${id}` : props.row?.path || '/marketplace');
              return (
                <a
                  href={href}
                  class={ready() && props.peer?.username && !listed().has(id) ? 'is-missing' : undefined}
                  title={card.name || ''}
                  draggable="false"
                >
                  <Show when={src} fallback={<span />}><img src={src} alt="" draggable="false" /></Show>
                </a>
              );
            }}
          </For>
        </span>
      </span>
    </Show>
  );
}
