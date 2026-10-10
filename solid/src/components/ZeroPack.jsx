import { createMemo, createSignal, For, Show } from 'solid-js';
import { inventoryListingHref } from '@market/inventory-listings.js';
import { formatOrderMoney } from '@market/order-status.js';
import { pickingOrdersMatch } from '@market/zero-pick.js';
import '@market/zero-pack.css';
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

/**
 * One pack line (market/src/zero-pack.jsx ZeroLine). Without `onMove` it is a
 * read-only line (the "waiting for the next merge" list): no drag, no button.
 */
export function ZeroLine(props) {
  const item = () => props.item;
  const location = () => item().location || item().powerTools?.location || '';
  const fromPowerTools = () => !item().location && Boolean(item().powerTools?.location);
  const where = () => [item().expansion, item().collectorNumber ? `#${item().collectorNumber}` : ''].filter(Boolean).join(' · ');
  const pt = () => powerToolsLine(item().powerTools);
  const ptPlace = () => (Number(item().powerTools?.position) > 0 ? `PT ${item().powerTools.position}` : '');
  return (
    <div
      class={['thread', 'zero-line', { 'is-picked': Boolean(props.picked) }]}
      draggable={Boolean(props.onMove)}
      onDragStart={(event) => props.onDragStart?.(event, item().itemId)}
    >
      <Show when={props.place != null}>
        <span class="zero-place" title="Place in this pack, by location">{props.place}</span>
      </Show>
      <span class={['zero-loc', { 'is-empty': !location() }]} title={fromPowerTools() ? 'Location from Power Tools' : 'MyPokoin location'}>
        {location() || 'No location'}
        <Show when={fromPowerTools()}><small> PT</small></Show>
      </span>
      <span class="thread-main">
        <strong class="thread-title">
          <Show when={item().cardId} fallback={item().name}>
            <a href={inventoryListingHref(item())}>{item().name}</a>
          </Show>
          <Show when={item().quantity > 1}><span class="zero-qty"> ×{item().quantity}</span></Show>
        </strong>
        <span class="thread-meta">
          {[where(), facets(item()), item().lineCents != null ? formatOrderMoney(item().lineCents, item().currency) : '', ptPlace()]
            .filter(Boolean)
            .join(' · ')}
          <Show when={pt()}><span class="zero-pt"> · {pt()}</span></Show>
        </span>
      </span>
      <Show when={props.onMove}>
        <button
          class="btn ghost zero-move"
          type="button"
          draggable={false}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => props.onMove(item().itemId, !props.picked)}
        >
          {props.picked ? 'Pick' : 'Picked'}
        </button>
      </Show>
    </div>
  );
}

function DropRow(props) {
  const [over, setOver] = createSignal(false);
  return (
    <DeskPanel flush title={props.title} extra={<span class="zero-progress">{props.hint}</span>}>
      <div
        class={['thread-list', 'zero-drop', { 'is-over': over() }]}
        onDragOver={(event) => { event.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          const itemId = event.dataTransfer.getData('text/plain');
          if (itemId) props.onDropTo(itemId);
        }}
      >
        <For
          each={props.items}
          fallback={<p class="zero-drop-empty">{props.picked ? 'Drag a card down, or click Picked.' : 'Nothing left to pick.'}</p>}
        >
          {(item) => (
            <ZeroLine
              item={item}
              place={props.places.get(item.itemId)}
              picked={props.picked}
              onMove={props.onMove}
              onDragStart={(event, itemId) => {
                event.dataTransfer.setData('text/plain', itemId);
                event.dataTransfer.effectAllowed = 'move';
              }}
            />
          )}
        </For>
      </div>
    </DeskPanel>
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

  function move(itemId, toPicked) {
    const next = new Set(picked());
    if (toPicked) next.add(itemId);
    else next.delete(itemId);
    writePicked(order().orderId, next);
    setPicked(next);
  }

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
        places={places()}
        onMove={move}
        onDropTo={(itemId) => move(itemId, false)}
      />
      <DropRow
        title="Picked"
        hint={`${doneItems().length} picked`}
        items={doneItems()}
        picked
        places={places()}
        onMove={move}
        onDropTo={(itemId) => move(itemId, true)}
      />
    </div>
  );
}
