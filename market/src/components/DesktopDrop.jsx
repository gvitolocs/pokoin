import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchArtist, fetchExpansionCards } from '../api.js';
import { addCatalogCards } from '../cart-add.js';
import { cartDropThumb } from '../cart-drop-size.js';
import {
  addDesktopCards,
  clearDesktopHold,
  removeDesktopCard,
  useDesktopHold,
} from '../desktop-hold.js';
import { downloadDesktopHoldPdf } from '../desktop-hold-pdf.js';
import { bundleOf, LISTING_DRAG_TYPE, readListingDrag } from '../chat-listing.js';
import { fetchSpeciesCards } from '../species-cards.js';
import CardArt from './CardArt.jsx';

export default function DesktopDrop({ onAddToCart }) {
  const items = useDesktopHold();
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState('');
  const thumb = cartDropThumb(items.length);

  async function acceptDrop(reference) {
    if (!reference) return;
    if (reference.kind === 'cards') {
      addDesktopCards(reference.cards || []);
      return;
    }
    const bundle = bundleOf(reference);
    if (bundle?.slug) {
      const cards = bundle.kind === 'artist'
        ? (await fetchArtist(bundle.slug, { limit: 400 }).catch(() => null))?.cards || []
        : bundle.kind === 'species'
          ? await fetchSpeciesCards(decodeURIComponent(bundle.slug)).catch(() => [])
          : (await fetchExpansionCards({ slug: bundle.slug }).catch(() => null))?.cards || [];
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
      const ok = await downloadDesktopHoldPdf(items);
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
          {items.map((row) => (
            <span
              key={row.id}
              className="cart-drop-card desktop-drop-card"
              style={{ width: thumb, height: Math.round(thumb * 88 / 63) }}
            >
              <Link to={row.path || '/marketplace'} title={row.name}>
                {row.imageUrl ? <CardArt src={row.imageUrl} alt="" card={row} /> : <span className="suggest-ph" />}
              </Link>
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
