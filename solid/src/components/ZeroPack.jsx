import { createMemo, createSignal, For, Show } from 'solid-js';
import { inventoryListingHref } from '@market/inventory-listings.js';
import ScanImage from './ScanImage.jsx';
import { homepageDerivativeUrl, ownCatalogImage, preferFullImage } from '@market/image-urls.js';
import { formatOrderMoney } from '@market/order-status.js';
import { pickingOrdersMatch } from '@market/zero-pick.js';
import '@market/zero-pack.css';
import { createPointerDrag } from '../lib/pointer-drag.js';
import { DeskPanel } from './Desk.jsx';

const PICKED_KEY = 'pokoin.ctZero.picked.';

function day(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
    : '—';
}

/** Ticked lines per shipment, this browser only (a picking aid, not shared state). */
function readPicked(orderId) {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PICKED_KEY + orderId) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch (_) {
    return new Set();
  }
}

function writePicked(orderId, picked) {
  try {
    if (picked.size) window.localStorage.setItem(PICKED_KEY + orderId, JSON.stringify([...picked]));
    else window.localStorage.removeItem(PICKED_KEY + orderId);
  } catch (_) {
    /* private mode: ticks just don't survive a reload */
  }
}

function facets(item) {
  return [
    item.condition,
    item.language,
    item.reverse ? 'Reverse' : '',
    item.firstEdition ? '1st ed.' : '',
    item.signed ? 'Signed' : '',
    item.altered ? 'Altered' : '',
    item.graded ? 'Graded' : '',
  ].filter(Boolean).join(' ');
}

function powerToolsLine(pt) {
  if (!pt) return '';
  const parts = [];
  if (pt.pickedQuantity != null) parts.push(`picked ${pt.pickedQuantity}`);
  else if (pt.orderState) parts.push(pt.orderState);
  if (pt.bin) parts.push(`bin ${pt.bin}`);
  return parts.length ? `Power Tools: ${parts.join(' · ')}` : '';
}

function lineImage(item) {
  return homepageDerivativeUrl(ownCatalogImage(
    { id: item?.cardId, name: item?.name || '' },
    preferFullImage(item?.imageUrl || ''),
  ));
}

/**
 * One pack line. Without `onMove` it is a
 * read-only line (the "waiting for the next merge" list): no drag, no button.
 */
export function ZeroLine(props) {
  const item = () => props.item;
  const location = () => item().location || item().powerTools?.location || '';
  const fromPowerTools = () => !item().location && Boolean(item().powerTools?.location);
  const where = () => [item().expansion, item().collectorNumber ? `#${item().collectorNumber}` : ''].filter(Boolean).join(' · ');
  const pt = () => powerToolsLine(item().powerTools);
  const ptPlace = () => (Number(item().powerTools?.position) > 0 ? `PT ${item().powerTools.position}` : '');
  const price = () => (item().lineCents != null ? formatOrderMoney(item().lineCents, item().currency) : '');
  const src = () => lineImage(item());
  const interactive = () => Boolean(props.onMove);
  return (
    <article
      class={['zero-card', { 'is-picked': Boolean(props.picked), 'is-draggable': interactive() }]}
      draggable="false"
      onPointerDown={(event) => {
        if (!interactive()) return;
        props.onPointerDown?.(event, {
          itemId: item().itemId,
          image: src(),
          label: item().name || '',
        });
      }}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
    >
      <div
        class="zero-card-art"
        onClick={() => {
          if (!interactive() || props.consumeClick?.()) return;
          props.onMove(item().itemId, !props.picked);
        }}
      >
        <ScanImage
          src={src()}
          label={item().name}
          letterClass="zero-card-fallback"
          width="126"
          height="176"
        />
        <span class={['zero-loc', { 'is-empty': !location() }]} title={fromPowerTools() ? 'Location from Power Tools' : 'MyPokoin location'}>
          {location() || 'No location'}
          <Show when={fromPowerTools()}><small> PT</small></Show>
        </span>
        <Show when={props.place != null}>
          <span class="zero-place" title="Place in this pack, by location">{props.place}</span>
        </Show>
        <Show when={item().quantity > 1}><span class="zero-qty">×{item().quantity}</span></Show>
        <Show when={props.picked}>
          <span class="zero-card-check" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="36" height="36">
              <path d="M5 12.5 10 17l9-10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
        </Show>
      </div>
      <div class="zero-card-body">
        <strong class="thread-title">
          <Show when={item().cardId} fallback={item().name}>
            <a href={inventoryListingHref(item())} draggable="false">{item().name}</a>
          </Show>
        </strong>
        <Show when={where()}><span class="thread-meta">{where()}</span></Show>
        <Show when={facets(item())}><span class="thread-meta">{facets(item())}</span></Show>
        <Show when={price()}><span class="zero-card-price">{price()}</span></Show>
        <Show when={ptPlace()}><span class="thread-meta">{ptPlace()}</span></Show>
        <Show when={pt()}><span class="zero-pt">{pt()}</span></Show>
      </div>
      <Show when={interactive()}>
        <button
          class="btn ghost zero-move"
          type="button"
          draggable="false"
          onClick={() => props.onMove(item().itemId, !props.picked)}
        >
          <Show when={props.picked} fallback={<><span class="zero-move-full">Mark picked</span><span class="zero-move-short">Picked</span></>}>
            Undo
          </Show>
        </button>
      </Show>
    </article>
  );
}

function DropRow(props) {
  return (
    <div
      class={['zero-column', { 'is-over': props.over }]}
      data-drop-zone={props.zone}
      ref={(element) => props.setZone?.(props.zone, element)}
    >
      <DeskPanel flush title={props.title} extra={<span class="zero-progress">{props.hint}</span>}>
        <div class="zero-grid">
          <For
            each={props.items}
            fallback={<p class="zero-drop-empty">{props.picked ? 'Nothing left to pick.' : 'Drag a card down, or click Mark picked.'}</p>}
          >
            {(item) => (
              <ZeroLine
                item={item}
                place={props.places.get(item.itemId)}
                picked={props.picked}
                onMove={props.onMove}
                onPointerDown={(event, payload) => props.onPointerDown?.(event, payload, props.zone)}
                onPointerMove={props.onPointerMove}
                onPointerUp={props.onPointerUp}
                onPointerCancel={props.onPointerCancel}
                consumeClick={props.consumeClick}
              />
            )}
          </For>
        </div>
      </DeskPanel>
    </div>
  );
}

/** One weekly Zero shipment in picking order, with Pick / Picked drop rows. */
export function ShipmentPanel(props) {
  const order = () => props.order;
  const [picked, setPicked] = createSignal(readPicked(props.order.orderId));
  const units = () => order().items.reduce((sum, item) => sum + item.quantity, 0);
  const places = createMemo(() => {
    const map = new Map();
    order().items.forEach((item, index) => map.set(item.itemId, index + 1));
    return map;
  });
  const open = () => order().items.filter((item) => !picked().has(item.itemId));
  const doneItems = () => order().items.filter((item) => picked().has(item.itemId));
  const match = () => (props.powerTools?.ok ? pickingOrdersMatch(order().items) : { comparable: false, equal: false });
  const hot = (zone) => pointer.view().phase === 'dragging' && pointer.view().over === zone;

  function move(itemId, toPicked) {
    const next = new Set(picked());
    if (toPicked) next.add(itemId);
    else next.delete(itemId);
    writePicked(order().orderId, next);
    setPicked(next);
  }

  const pointer = createPointerDrag({
    onMove(action) {
      if (!action?.payload?.itemId || action.from === action.to) return;
      move(action.payload.itemId, action.to === 'picked');
    },
  });

  const title = () => [
    `Shipment ${order().code || order().orderId}`,
    order().packingNumber != null ? `packing #${order().packingNumber}` : '',
    order().paidAt ? `merged ${day(order().paidAt)}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <div class="zero-pack">
      <p class="zero-pack-title">
        {title()}
        <span>{picked().size}/{order().items.length} picked · {units()} card{units() === 1 ? '' : 's'}</span>
      </p>
      <Show when={props.powerTools?.ok && order().items.length}>
        <p class={match().equal ? 'desk-ok' : 'ct-token-hint is-warn'} role="status">
          {match().equal
            ? 'Your location order matches the Power Tools position order.'
            : match().comparable
              ? 'Your location order differs from the Power Tools position order.'
              : 'Power Tools is connected, but this pack is missing a position on some cards.'}
        </p>
      </Show>
      <DropRow
        title="Pick"
        hint={`${open().length} still to pick · location order`}
        items={open()}
        picked={false}
        zone="pick"
        over={hot('pick')}
        places={places()}
        onMove={move}
        setZone={pointer.setZone}
        onPointerDown={pointer.onPointerDown}
        onPointerMove={pointer.onPointerMove}
        onPointerUp={pointer.onPointerUp}
        onPointerCancel={pointer.onPointerCancel}
        consumeClick={pointer.consumeClick}
      />
      <DropRow
        title="Picked"
        hint={`${doneItems().length} picked`}
        items={doneItems()}
        picked
        zone="picked"
        over={hot('picked')}
        places={places()}
        onMove={move}
        setZone={pointer.setZone}
        onPointerDown={pointer.onPointerDown}
        onPointerMove={pointer.onPointerMove}
        onPointerUp={pointer.onPointerUp}
        onPointerCancel={pointer.onPointerCancel}
        consumeClick={pointer.consumeClick}
      />
    </div>
  );
}
