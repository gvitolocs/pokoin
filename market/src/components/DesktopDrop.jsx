import { useState } from 'react';
import { Link } from 'react-router-dom';
import { addCatalogCards } from '../cart-add.js';
import { cartDropThumb } from '../cart-drop-size.js';
import {
  clearDesktopHold,
  removeDesktopCard,
  setDesktopQty,
} from '../desktop-hold.js';
import { useDesktopHold } from '../desktop-hold-hooks.js';
import { addDesktopDrop, desktopCapacityNote } from '../desktop-drop-add.js';
import { downloadDesktopHoldPdf } from '../desktop-hold-pdf.js';
import { LISTING_DRAG_TYPE, readListingDrag } from '../chat-listing.js';
import {
  acceptTrayDrop,
  desktopItemReference,
  endTrayDrag,
  startTrayDrag,
  TRAY_DESKTOP,
} from '../tray-drag.js';
import { TRAY_FULL_ART_MAX, TRAY_VISIBLE } from '../tray-render.js';
import CardArt from './CardArt.jsx';
import QtyStepper from './QtyStepper.jsx';

export default function DesktopDrop({ onAddToCart }) {
  const items = useDesktopHold();
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState('');
  const [showAll, setShowAll] = useState(false);
  // Thousands of cards (a whole artist) must not mount thousands of scans.
  const shown = showAll ? items : items.slice(0, TRAY_VISIBLE);
  const thumb = cartDropThumb(shown.length);
  const fullArt = items.length <= TRAY_FULL_ART_MAX;

  function reportCapacity() {
    const full = desktopCapacityNote();
    if (full) setNote(full);
  }

  async function acceptDrop(reference) {
    await addDesktopDrop(reference);
    reportCapacity();
  }

  async function addAllToCart() {
    if (!items.length || busy || typeof onAddToCart !== 'function') return;
    setBusy(true);
    setNote('');
    try {
      const added = await addCatalogCards(
        items.map((row) => ({
          id: row.id,
          name: row.name,
          canonicalPath: row.path,
          imageUrl: row.imageUrl,
        })),
        onAddToCart,
      );
      setNote(added
        ? `Added ${added} listed card${added === 1 ? '' : 's'} to cart`
        : 'No listed copies to add');
    } catch (_) {
      setNote('Could not add to cart');
    } finally {
      setBusy(false);
    }
  }

  async function exportPdf() {
    if (!items.length || exporting) return;
    setExporting(true);
    setNote('Building PDF…');
    try {
      const ok = await downloadDesktopHoldPdf(items, {
        onProgress: (done, total) => setNote(`Building PDF… ${done}/${total}`),
      });
      setNote(ok
        ? `Exported ${items.length} card${items.length === 1 ? '' : 's'} as PDF`
        : 'Could not export PDF');
    } catch (_) {
      setNote('Could not export PDF');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div
      className={`cart-drop desktop-drop${over ? ' is-over' : ''}`}
      role="region"
      aria-label="Desktop"
      onDragOver={(event) => {
        if (![...(event.dataTransfer?.types || [])].includes(LISTING_DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setOver(false);
      }}
      onDrop={(event) => {
        if (![...(event.dataTransfer?.types || [])].includes(LISTING_DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        acceptTrayDrop(TRAY_DESKTOP);
        void acceptDrop(readListingDrag(event));
      }}
    >
      <strong>Desktop</strong>
      <div className="desktop-drop-actions">
        <button
          type="button"
          className="btn ghost"
          disabled={!items.length}
          onClick={() => {
            clearDesktopHold();
            setNote('');
            setShowAll(false);
          }}
        >
          Clear desktop
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={!items.length || exporting}
          onClick={() => void exportPdf()}
        >
          {exporting ? 'Exporting…' : 'Export PDF'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!items.length || busy}
          onClick={() => void addAllToCart()}
        >
          {busy ? 'Adding…' : 'Add to cart'}
        </button>
      </div>
      {note ? <p className="desktop-drop-note" role="status">{note}</p> : null}
      {items.length ? (
        <div className="cart-drop-grid">
          {shown.map((row) => (
            <span
              key={row.id}
              className="cart-drop-card desktop-drop-card"
              style={{ width: thumb, height: Math.round(thumb * 88 / 63) }}
              draggable
              onDragStart={(event) => {
                const reference = desktopItemReference(row);
                if (!reference) {
                  event.preventDefault();
                  return;
                }
                event.stopPropagation();
                startTrayDrag(event, {
                  tray: TRAY_DESKTOP,
                  reference,
                  remove: () => removeDesktopCard(row.id),
                });
              }}
              onDragEnd={() => endTrayDrag()}
            >
              <Link to={row.path || '/marketplace'} title={row.name} draggable={false}>
                {row.imageUrl ? <CardArt src={row.imageUrl} alt="" card={row} full={fullArt} /> : <span className="suggest-ph" />}
              </Link>
              <QtyStepper
                qty={row.qty || 1}
                max={row.stock || 99}
                onChange={(next) => setDesktopQty(row.id, next)}
              />
              <button
                type="button"
                className="desktop-drop-x"
                aria-label={`Remove ${row.name}`}
                title="Remove"
                onClick={() => removeDesktopCard(row.id)}
              >
                ×
              </button>
            </span>
          ))}
          {items.length > TRAY_VISIBLE ? (
            <button
              type="button"
              className="btn ghost desktop-drop-more"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? 'Show fewer' : `+${items.length - TRAY_VISIBLE} more · Show all`}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="cart-drop-empty">
          <div className="empty-art" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28">
              <path fill="currentColor" d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v8h14V7H5zm-1 12h16v2H4v-2z" />
            </svg>
          </div>
          <p>Draw the shape of your next collection</p>
        </div>
      )}
    </div>
  );
}
