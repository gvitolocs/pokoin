import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DeskPanel } from './components/Desk.jsx';
import { inventoryListingHref } from './inventory-listings.js';
import { formatOrderMoney } from './order-status.js';
import { pickingOrdersMatch } from './zero-pick.js';
import './zero-pack.css';

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

function ZeroLine({ item, place, picked, onMove, onDragStart }) {
  const location = item.location || item.powerTools?.location || '';
  const fromPowerTools = !item.location && Boolean(item.powerTools?.location);
  const where = [item.expansion, item.collectorNumber ? `#${item.collectorNumber}` : ''].filter(Boolean).join(' · ');
  const pt = powerToolsLine(item.powerTools);
  const ptPlace = Number(item.powerTools?.position) > 0 ? `PT ${item.powerTools.position}` : '';
  return (
    <div
      className={`thread zero-line${picked ? ' is-picked' : ''}`}
      draggable
      onDragStart={(event) => onDragStart(event, item.itemId)}
    >
      <span className="zero-place" title="Place in this pack, by location">{place}</span>
      <span className={`zero-loc${location ? '' : ' is-empty'}`} title={fromPowerTools ? 'Location from Power Tools' : 'MyPokoin location'}>
        {location || 'No location'}
        {fromPowerTools ? <small> PT</small> : null}
      </span>
      <span className="thread-main">
        <strong className="thread-title">
          {item.cardId ? <Link to={inventoryListingHref(item)}>{item.name}</Link> : item.name}
          {item.quantity > 1 ? <span className="zero-qty"> ×{item.quantity}</span> : null}
        </strong>
        <span className="thread-meta">
          {[where, facets(item), item.lineCents != null ? formatOrderMoney(item.lineCents, item.currency) : '', ptPlace]
            .filter(Boolean)
            .join(' · ')}
          {pt ? <span className="zero-pt"> · {pt}</span> : null}
        </span>
      </span>
      <button
        className="btn ghost zero-move"
        type="button"
        draggable={false}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => onMove(item.itemId, !picked)}
      >
        {picked ? 'Pick' : 'Picked'}
      </button>
    </div>
  );
}

function DropRow({ title, hint, items, picked, places, onMove, onDropTo }) {
  const [over, setOver] = useState(false);
  return (
    <DeskPanel flush title={title} extra={<span className="zero-progress">{hint}</span>}>
      <div
        className={`thread-list zero-drop${over ? ' is-over' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          const itemId = event.dataTransfer.getData('text/plain');
          if (itemId) onDropTo(itemId);
        }}
      >
        {items.length ? items.map((item) => (
          <ZeroLine
            key={item.itemId}
            item={item}
            place={places.get(item.itemId)}
            picked={picked}
            onMove={onMove}
            onDragStart={(event, itemId) => {
              event.dataTransfer.setData('text/plain', itemId);
              event.dataTransfer.effectAllowed = 'move';
            }}
          />
        )) : <p className="zero-drop-empty">{picked ? 'Drag a card down, or click Picked.' : 'Nothing left to pick.'}</p>}
      </div>
    </DeskPanel>
  );
}

export function ShipmentPanel({ order, powerTools }) {
  const [picked, setPicked] = useState(() => readPicked(order.orderId));
  const units = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const places = useMemo(() => {
    const map = new Map();
    order.items.forEach((item, index) => map.set(item.itemId, index + 1));
    return map;
  }, [order.items]);
  const open = order.items.filter((item) => !picked.has(item.itemId));
  const doneItems = order.items.filter((item) => picked.has(item.itemId));
  const match = powerTools?.ok ? pickingOrdersMatch(order.items) : { comparable: false, equal: false };

  function move(itemId, toPicked) {
    setPicked((current) => {
      const next = new Set(current);
      if (toPicked) next.add(itemId);
      else next.delete(itemId);
      writePicked(order.orderId, next);
      return next;
    });
  }

  const title = [
    `Shipment ${order.code || order.orderId}`,
    order.packingNumber != null ? `packing #${order.packingNumber}` : '',
    order.paidAt ? `merged ${day(order.paidAt)}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <div className="zero-pack">
      <p className="zero-pack-title">
        {title}
        <span>{picked.size}/{order.items.length} picked · {units} card{units === 1 ? '' : 's'}</span>
      </p>
      {powerTools?.ok && order.items.length ? (
        <p className={match.equal ? 'desk-ok' : 'ct-token-hint is-warn'} role="status">
          {match.equal
            ? 'Your location order matches the Power Tools position order.'
            : match.comparable
              ? 'Your location order differs from the Power Tools position order.'
              : 'Power Tools is connected, but this pack is missing a position on some cards.'}
        </p>
      ) : null}
      <DropRow
        title="Pick"
        hint={`${open.length} still to pick · location order`}
        items={open}
        picked={false}
        places={places}
        onMove={move}
        onDropTo={(itemId) => move(itemId, false)}
      />
      <DropRow
        title="Picked"
        hint={`${doneItems.length} picked`}
        items={doneItems}
        picked
        places={places}
        onMove={move}
        onDropTo={(itemId) => move(itemId, true)}
      />
    </div>
  );
}
