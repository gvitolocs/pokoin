import { createSignal, For, Show } from 'solid-js';
import { addCatalogCards } from '@market/cart-add.js';
import { cartDropThumb } from '@market/cart-drop-size.js';
import { readListingDrag } from '@market/chat-listing.js';
import { addDesktopDrop, desktopCapacityNote } from '@market/desktop-drop-add.js';
import { clearDesktopHold, removeDesktopCard, setDesktopQty } from '@market/desktop-hold.js';
import { acceptTrayDrop, desktopItemReference, endTrayDrag, startTrayDrag, TRAY_DESKTOP } from '@market/tray-drag.js';
import { TRAY_FULL_ART_MAX, TRAY_VISIBLE } from '@market/tray-render.js';
import { carriesListing } from '../lib/drag.js';
import { addCartItem } from '../stores/cart.js';
import { desktopItems } from '../stores/desktop.js';
import CardArt from './CardArt.jsx';
import QtyStepper from './QtyStepper.jsx';

const DESKTOP_ICON = 'M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v8h14V7H5zm-1 12h16v2H4v-2z';

/**
 * Header Desktop hold tray (market/src/components/DesktopDrop.jsx): park
 * cards, export them as a PDF, or send every listed one to the cart. Its own
 * chunk — mounts only while hovered/clicked or while a card is dragged.
 */
export default function DesktopDrop() {
  const [over, setOver] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [exporting, setExporting] = createSignal(false);
  const [note, setNote] = createSignal('');
  const [showAll, setShowAll] = createSignal(false);
  // Thousands of cards (a whole artist) must not mount thousands of scans.
  const shown = () => (showAll() ? desktopItems() : desktopItems().slice(0, TRAY_VISIBLE));
  const thumb = () => cartDropThumb(shown().length);
  const fullArt = () => desktopItems().length <= TRAY_FULL_ART_MAX;

  async function acceptDrop(reference) {
    await addDesktopDrop(reference);
    const full = desktopCapacityNote();
    if (full) setNote(full);
  }

  async function addAllToCart() {
    const items = desktopItems();
    if (!items.length || busy()) return;
    setBusy(true);
    setNote('');
    try {
      const added = await addCatalogCards(
        items.map((row) => ({ id: row.id, name: row.name, canonicalPath: row.path, imageUrl: row.imageUrl })),
        addCartItem,
      );
      setNote(added ? `Added ${added} listed card${added === 1 ? '' : 's'} to cart` : 'No listed copies to add');
    } catch (_) {
      setNote('Could not add to cart');
    } finally {
      setBusy(false);
    }
  }

  async function exportPdf() {
    const items = desktopItems();
    if (!items.length || exporting()) return;
    setExporting(true);
    setNote('Building PDF…');
    try {
      const { downloadDesktopHoldPdf } = await import('@market/desktop-hold-pdf.js');
      const ok = await downloadDesktopHoldPdf(items, {
        onProgress: (done, total) => setNote(`Building PDF… ${done}/${total}`),
      });
      setNote(ok ? `Exported ${items.length} card${items.length === 1 ? '' : 's'} as PDF` : 'Could not export PDF');
    } catch (_) {
      setNote('Could not export PDF');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div
      class={['cart-drop desktop-drop', { 'is-over': over() }]}
      role="region"
      aria-label="Desktop"
      onDragOver={(event) => {
        if (!carriesListing(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setOver(false);
      }}
      onDrop={(event) => {
        if (!carriesListing(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        acceptTrayDrop(TRAY_DESKTOP);
        void acceptDrop(readListingDrag(event));
      }}
    >
      <strong>Desktop</strong>
      <div class="desktop-drop-actions">
        <button
          type="button"
          class="btn ghost"
          disabled={!desktopItems().length}
          onClick={() => {
            clearDesktopHold();
            setNote('');
            setShowAll(false);
          }}
        >
          Clear desktop
        </button>
        <button type="button" class="btn ghost" disabled={!desktopItems().length || exporting()} onClick={() => void exportPdf()}>
          {exporting() ? 'Exporting…' : 'Export PDF'}
        </button>
        <button type="button" class="btn" disabled={!desktopItems().length || busy()} onClick={() => void addAllToCart()}>
          {busy() ? 'Adding…' : 'Add to cart'}
        </button>
      </div>
      <Show when={note()}>
        <p class="desktop-drop-note" role="status">{note()}</p>
      </Show>
      <Show
        when={desktopItems().length}
        fallback={(
          <div class="cart-drop-empty">
            <div class="empty-art" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d={DESKTOP_ICON} /></svg>
            </div>
            <p>Draw the shape of your next collection</p>
          </div>
        )}
      >
        <div class="cart-drop-grid">
          <For each={shown()} keyed={(row) => row.id}>
            {(row) => (
              <span
                class="cart-drop-card desktop-drop-card"
                style={{ width: `${thumb()}px`, height: `${Math.round(thumb() * 88 / 63)}px` }}
                draggable="true"
                onDragStart={(event) => {
                  const reference = desktopItemReference(row());
                  if (!reference) {
                    event.preventDefault();
                    return;
                  }
                  event.stopPropagation();
                  const id = row().id;
                  startTrayDrag(event, { tray: TRAY_DESKTOP, reference, remove: () => removeDesktopCard(id) });
                }}
                onDragEnd={() => endTrayDrag()}
              >
                <a href={row().path || '/marketplace'} title={row().name} draggable="false">
                  <Show when={row().imageUrl} fallback={<span class="suggest-ph" />}>
                    <CardArt src={row().imageUrl} alt="" card={row()} full={fullArt()} />
                  </Show>
                </a>
                <QtyStepper qty={row().qty || 1} max={row().stock || 99} onChange={(next) => setDesktopQty(row().id, next)} />
                <button
                  type="button"
                  class="desktop-drop-x"
                  aria-label={`Remove ${row().name}`}
                  title="Remove"
                  onClick={() => removeDesktopCard(row().id)}
                >
                  ×
                </button>
              </span>
            )}
          </For>
          <Show when={desktopItems().length > TRAY_VISIBLE}>
            <button type="button" class="btn ghost desktop-drop-more" onClick={() => setShowAll((value) => !value)}>
              {showAll() ? 'Show fewer' : `+${desktopItems().length - TRAY_VISIBLE} more · Show all`}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
