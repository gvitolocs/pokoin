import { createSignal, For, Repeat, Show } from 'solid-js';
import { artCutVars } from '@market/art-cut.js';
import { openListingChat } from '@market/chat-dock-store.js';
import { listingReference, listingsReference, writeListingDrag } from '@market/chat-listing.js';
import { homepageDerivativeUrl, ownCatalogImage, preferFullImage } from '@market/image-urls.js';
import {
  conditionChipSrc,
  conditionShort,
  conditionTone,
  listingExtraTags,
  listingLanguageFlag,
  publicShopSellerLabel,
  sellerCountryFlag,
  sellerHref,
} from '@market/listing-meta.js';
import { listingSelectId } from '@market/shop-marquee.js';
import { chatPhotoDisplayUrl } from '@market/user-photo-urls.js';
import { buyerParts } from '../../stores/buyer.js';
import { ThumbZoom } from '../ArtworkZoom.jsx';
import PriceStack from '../PriceStack.jsx';

/** Shop rows wrapper (market/src/components/ShopList.jsx, without the select band). */
export function ShopList(props) {
  return <div class={['shop-list', props.class]}>{props.children}</div>;
}

function ShopScan(props) {
  const full = () => preferFullImage(props.image) || props.image;
  const thumb = () => homepageDerivativeUrl(props.image) || props.image;
  return (
    <ThumbZoom src={full()} full alt={props.name || ''}>
      <span class="art-cut shop-art" style={artCutVars({ set: props.setName || '', name: props.name })}>
        <img
          src={thumb()}
          alt=""
          draggable="false"
          onError={(event) => {
            const img = event.currentTarget;
            if (img.dataset.fallback) return;
            img.dataset.fallback = '1';
            img.src = full();
          }}
        />
      </span>
    </ThumbZoom>
  );
}

function Flag(props) {
  return (
    <Show when={props.flag}>
      <Show
        when={props.flag.emoji}
        fallback={(
          <Show when={props.flag.src}>
            <img
              class={props.class}
              src={props.flag.src}
              alt={props.flag.label}
              title={props.flag.label}
              width="18"
              height="18"
            />
          </Show>
        )}
      >
        <span
          class={props.class}
          title={props.flag.label || props.flag.short}
          aria-label={props.flag.label || props.flag.short}
        >
          {props.flag.emoji}
        </span>
      </Show>
    </Show>
  );
}

function MessageIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
    </svg>
  );
}

function CartIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path fill="currentColor" d="M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM6.2 6l.8 2h12.2l-1.6 6H8.1L6.2 6ZM5.2 4H2V2h4l.4 1H22l-2.4 9H7.5L5.2 4Z" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
      />
    </svg>
  );
}

/**
 * One shop listing (market/src/components/ShopListing.jsx). Same markup and
 * drag payloads; the rubber-band multi-select is not ported yet, so a row
 * drags itself (or `dragOffers` when the desk passes a pile).
 */
export default function ShopListingRow(props) {
  const offer = () => props.offer;
  const [added, setAdded] = createSignal(false);
  const [pick, setPick] = createSignal(1);
  const name = () => publicShopSellerLabel(offer());
  const stock = () => Math.max(0, Math.trunc(Number(offer()?.quantityAvailable ?? offer()?.quantity_available) || 0));
  const choices = () => Math.max(stock(), 1);
  const reference = () => ({
    ...listingReference({ offer: offer(), card: props.card, qty: pick() }),
    qty: pick(),
    stock: choices(),
  });
  const href = () => sellerHref(offer());
  const country = () => sellerCountryFlag(offer()?.sellerCountry);
  const language = () => listingLanguageFlag(offer()?.language);
  const tone = () => conditionTone(offer()?.condition) || 'nm';
  const cond = () => conditionShort(offer()?.condition);
  const tags = () => listingExtraTags(offer());
  const cardPath = () => offer()?.canonicalPath || offer()?.canonical_path || '';
  const cardName = () => offer()?.cardName || offer()?.name || '';
  const setName = () => offer()?.setName || '';
  const image = () => ownCatalogImage(props.card || {
    id: offer()?.cardId || offer()?.card_id,
    name: cardName(),
    canonicalPath: cardPath(),
  }, preferFullImage(offer()?.cardImageUrl || offer()?.imageUrl || ''));
  const photos = () => (Array.isArray(offer()?.photoUrls) ? offer().photoUrls.slice(0, 2) : []);

  function inspectListing(event) {
    if (event.target?.closest?.(
      'a, button, input, select, textarea, label, .ct-qty, .shop-row-actions, .shop-owner-actions',
    )) {
      return;
    }
    if (props.onInspect) {
      event.preventDefault();
      event.stopPropagation();
      props.onInspect(event);
    }
  }

  function dragStart(event) {
    const row = offer();
    const pile = props.dragOffers;
    if (pile?.length > 1) {
      const cards = pile.map((item) => listingReference({
        offer: item,
        card: item === row ? props.card : {
          id: item.cardId || item.card_id,
          name: item.cardName || item.name,
          canonicalPath: item.canonicalPath || item.canonical_path,
          imageUrl: item.cardImageUrl || item.imageUrl || item.image_url,
          homepageImageUrl: item.homepageImageUrl || item.homepage_image_url,
          gridImageUrl: item.gridImageUrl || item.grid_image_url,
        },
        qty: item === row ? pick() : 1,
      }));
      writeListingDrag(event, listingsReference(cards));
      return;
    }
    writeListingDrag(event, reference());
  }

  const cardFace = () => (
    <>
      <Show when={image()} fallback={<span class="shop-card-ph" />}>
        <ShopScan image={image()} name={cardName()} setName={setName()} />
      </Show>
      <span class="shop-card-copy">
        <strong>{cardName() || 'Card'}</strong>
        <Show when={setName()}><em>{setName()}</em></Show>
      </span>
    </>
  );

  const seller = () => (
    <>
      <Flag flag={country()} class="shop-flag shop-flag-country" />
      <span class="shop-brand">{name()}</span>
    </>
  );

  return (
    <div
      class={['shop-row', {
        mine: props.mine,
        'is-profile': props.showCard,
        'is-editing': props.editing,
        'is-selected': props.selected,
      }]}
      data-listing-id={listingSelectId(offer())}
      draggable="true"
      onClick={inspectListing}
      onDragStart={dragStart}
    >
      <Show
        when={props.showCard}
        fallback={(
          <Show when={href()} fallback={<span class="shop-seller">{seller()}</span>}>
            <a class="shop-seller" href={href()} onClick={(event) => event.stopPropagation()}>
              {seller()}
            </a>
          </Show>
        )}
      >
        <Show when={cardPath()} fallback={<span class="shop-card">{cardFace()}</span>}>
          <a class="shop-card" href={cardPath()} onClick={(event) => event.stopPropagation()}>
            {cardFace()}
          </a>
        </Show>
      </Show>
      <span class="shop-facets">
        <span class="shop-txt">
          <For each={tags()}>
            {(tag) => <em class={tag === 'Reverse' ? 'meta-chip is-reverse' : 'meta-chip'}>{tag}</em>}
          </For>
        </span>
        <img
          class={['shop-cond', `is-${tone()}`]}
          src={conditionChipSrc(offer()?.condition)}
          alt={cond()}
          title={cond()}
          width="40"
          height="28"
          draggable="false"
        />
        <Flag flag={language()} class="shop-flag shop-flag-lang" />
      </span>
      <span class="shop-offer">
        <span class="shop-px"><PriceStack parts={buyerParts(offer()?.pricePkn, offer()?.sellerAcceptsPkn)} /></span>
        <Show when={!props.mine}>
          <Show
            when={choices() > 1}
            fallback={<span class="ct-qty is-single" aria-label="Quantity 1">1</span>}
          >
            <label
              class="ct-qty"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <select
                aria-label={`Quantity, ${Math.min(pick(), choices())} available`}
                value={String(Math.min(pick(), choices()))}
                onChange={(event) => {
                  event.stopPropagation();
                  setPick(Number(event.currentTarget.value) || 1);
                }}
              >
                <Repeat count={choices()}>
                  {(index) => (
                    <option value={String(index + 1)} selected={index + 1 === Math.min(pick(), choices())}>
                      {index + 1}
                    </option>
                  )}
                </Repeat>
              </select>
            </label>
          </Show>
        </Show>
      </span>
      <Show when={!props.mine}>
        <span class="shop-row-actions">
          <Show when={reference().sellerUid}>
            <button
              type="button"
              class="shop-icon"
              aria-label={reference().seller
                ? `Message ${reference().seller} about this listing`
                : 'Message this seller about this listing'}
              title="Message"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openListingChat(reference());
              }}
            >
              <MessageIcon />
            </button>
          </Show>
          <Show when={Boolean(props.onCart)}>
            <button
              type="button"
              class={['shop-icon is-cart', { 'is-added': added() }]}
              aria-label={added() ? 'Added to cart' : 'Add to cart'}
              title={added() ? 'Added to cart' : 'Add to cart'}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onCart?.(pick());
                setAdded(true);
              }}
            >
              <CartIcon />
            </button>
          </Show>
        </span>
      </Show>
      <Show when={props.mine}>
        <span class="shop-owner-actions">
          <button
            type="button"
            class={['icon-btn shop-edit', { on: props.editing }]}
            disabled={props.listingBusy}
            title={props.editing ? 'Editing this listing' : 'Edit listing'}
            aria-label={props.editing ? 'Editing this listing' : 'Edit listing'}
            aria-pressed={props.editing ? 'true' : 'false'}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              props.onEdit?.();
            }}
          >
            <EditIcon />
          </button>
          <button
            type="button"
            class="icon-btn shop-trash"
            disabled={props.listingBusy}
            title="Cancel listing"
            aria-label="Cancel listing"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              props.onCancel?.();
            }}
          >
            <TrashIcon />
          </button>
        </span>
      </Show>
      <Show when={photos().length}>
        <span class="shop-photos">
          <For each={photos()}>
            {(url) => (
              <span class="shop-photo">
                <img src={chatPhotoDisplayUrl(url)} alt="" draggable="false" />
                <img class="shop-photo-big" src={chatPhotoDisplayUrl(url)} alt="" draggable="false" />
              </span>
            )}
          </For>
        </span>
      </Show>
    </div>
  );
}
