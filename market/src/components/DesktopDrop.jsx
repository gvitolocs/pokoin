import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchArtist } from '../api.js';
import { addCatalogCards } from '../cart-add.js';
import { cartDropThumb } from '../cart-drop-size.js';
import {
  addDesktopCards,
  clearDesktopHold,
  DESKTOP_MAX,
  desktopHoldMemoryOnly,
  readDesktopHold,
  removeDesktopCard,
  setDesktopQty,
  useDesktopHold,
} from '../desktop-hold.js';
import { downloadDesktopHoldPdf } from '../desktop-hold-pdf.js';
import { bundleOf, LISTING_DRAG_TYPE, readListingDrag } from '../chat-listing.js';
import { fetchSpeciesCards } from '../species-cards.js';
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
    if (desktopHoldMemoryOnly()) {
      setNote('Browser storage is full: the desktop is kept until you close this tab.');
    } else if (readDesktopHold().length >= DESKTOP_MAX) {
      setNote(`Desktop is full (${DESKTOP_MAX} cards).`);
    }
  }

  async function acceptDrop(reference) {
    await addDropped(reference);
    reportCapacity();
  }

  async function addDropped(reference) {
    if (!reference) return;
    if (reference.kind === 'cards') {
      addDesktopCards((reference.cards || []).map((row) => ({
        id: row.cardId || row.id,
        name: row.cardName || row.name,
        imageUrl: row.imageUrl,
        path: row.path,
        set: row.setName,
        setName: row.setName,
        number: row.number,
        rarity: row.rarity,
        artist: row.artist,
        pricePkn: row.pricePkn,
        qty: row.qty,
        stock: row.stock,
      })));
      return;
    }
    const bundle = bundleOf(reference);
    if (bundle?.slug) {
      // Expansion drops park the set logo only — not every card in the set.
      if (bundle.kind === 'expansion') {
        addDesktopCards([{
          id: `expansion:${bundle.slug}`,
          name: reference.cardName,
          imageUrl: reference.imageUrl,
          path: reference.path || `/marketplace/sets/${bundle.slug}`,
          set: reference.setName || reference.cardName,
          setName: reference.setName || reference.cardName,
        }]);
        return;
      }
      const cards = bundle.kind === 'artist'
        ? (await fetchArtist(bundle.slug, { limit: DESKTOP_MAX }).catch(() => null))?.cards || []
        : await fetchSpeciesCards(decodeURIComponent(bundle.slug)).catch(() => []);
      addDesktopCards(cards);
      return;
    }
    if (!reference.cardId) return;
    addDesktopCards([{
      id: reference.cardId,
      name: reference.cardName,
      imageUrl: reference.imageUrl,
      path: reference.path,
      set: reference.setName,
      setName: reference.setName,
      number: reference.number,
      rarity: reference.rarity,
      artist: reference.artist,
      pricePkn: reference.pricePkn,
      qty: reference.qty,
      stock: reference.stock,
    }]);
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
