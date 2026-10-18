import { createSignal, For, onSettled, Show } from 'solid-js';
import { useGameNavigate } from '../lib/game-navigate.js';
import {
  cardHref,
  catalogFromScanHit,
  identifyScan,
  publicIdFromScanHit,
  scanHitsOf,
} from '@market/api.js';
import { inventoryListingHref } from '@market/inventory-listings.js';
import { Alert, DeskPanel, FilePill, PageHead, Thread } from '../components/Desk.jsx';
import { usePageTitle } from './tools/board.jsx';

/** Public photo identify page: /scan, /cardscan, /scancard. */
export default function Scan() {
  const navigate = useGameNavigate();
  const [preview, setPreview] = createSignal('');
  const [query, setQuery] = createSignal('');
  const [file, setFile] = createSignal(null);
  const [hits, setHits] = createSignal([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  usePageTitle('Scan · Pokoin');

  let objectUrl = '';
  onSettled(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  function onFile(event) {
    const next = event.currentTarget.files?.[0];
    if (!next) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(next);
    setPreview(objectUrl);
    setFile(() => next);
    setHits([]);
    setError('');
    setQuery(next.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
  }

  function search(event) {
    event?.preventDefault?.();
    const next = query().trim();
    navigate(next ? `/marketplace/search?q=${encodeURIComponent(next)}` : '/marketplace/search');
  }

  async function identify(event) {
    event.preventDefault();
    const photo = file();
    if (!photo) {
      search();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = await identifyScan(photo);
      const resolved = [];
      for (const hit of scanHitsOf(data)) {
        const card = await catalogFromScanHit(hit);
        resolved.push({
          hit,
          card,
          publicId: publicIdFromScanHit(hit),
          name: hit.name || hit.card_name || card?.name || 'Unknown',
          set: hit.set || hit.set_name || card?.set || '',
          number: hit.collector_number || hit.number || card?.number || '',
        });
      }
      setHits(resolved);
      if (!resolved.length) setError('No match. Search the catalog below.');
    } catch (err) {
      setError(err.message || 'Scan identify failed.');
      setHits([]);
    } finally {
      setBusy(false);
    }
  }

  const rowHref = (row) => (row.card ? cardHref(row.card) : (row.publicId ? inventoryListingHref({ cardId: row.publicId }) : ''));

  return (
    <div class="page desk">
      <PageHead
        kicker="Identify"
        title="Card scan"
        lede="Photo posts to api.pokoin.com/api/scan/identify on leftover JPEG singles (pokemon_generic). TCGPlayer product ids are not desk URLs."
      >
        <a class="btn ghost" href="/marketplace">Shop</a>
      </PageHead>
      <form onSubmit={identify}>
        <DeskPanel
          title="Photo or name"
          actions={(
            <>
              <button class="btn" type="submit" disabled={busy()}>
                {busy() ? 'Identifying…' : (file() ? 'Identify photo' : 'Search marketplace')}
              </button>
              <button class="btn ghost" type="button" onClick={search}>Search catalog</button>
            </>
          )}
        >
          <div class="scan-stage">
            <div>
              <Show
                when={preview()}
                fallback={<div class="empty-art" style={{ width: '100%', height: '220px', 'border-radius': '12px' }}>No photo</div>}
              >
                <img class="scan-preview" src={preview()} alt="Selected card" />
              </Show>
            </div>
            <div class="scan-fields">
              <FilePill accept="image/*" capture="environment" onChange={onFile}>
                {file() ? file().name : 'Choose or capture a card'}
              </FilePill>
              <label class="sell-field">
                Search catalog
                <input value={query()} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Card name" />
              </label>
              <Alert>{error()}</Alert>
            </div>
          </div>
        </DeskPanel>
      </form>
      <Show when={hits().length}>
        <DeskPanel title="Matches">
          <div class="thread-list">
            <For each={hits()}>
              {(row) => (
                <Show
                  when={rowHref(row)}
                  fallback={(
                    <article class="thread">
                      <span class="thread-main">
                        <strong class="thread-title">{row.name}</strong>
                        <span class="thread-meta">No catalog match. TCGplayer id ignored.</span>
                      </span>
                    </article>
                  )}
                >
                  <Thread
                    to={rowHref(row)}
                    title={row.name}
                    meta={[row.set, row.number].filter(Boolean).join(' · ') || 'Matched printing'}
                  />
                </Show>
              )}
            </For>
          </div>
        </DeskPanel>
      </Show>
    </div>
  );
}
