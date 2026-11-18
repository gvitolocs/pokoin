import { createMemo, createSignal, For, Show, untrack } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import data from '@market/../public/review/western-artists.json';
import TestDock from '../components/TestDock.jsx';
import { BoardBar, usePageTitle } from './tools/board.jsx';

/** OCR illustrator credits vs pokemontcg.io names. */
export default function OcrArtists() {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = createSignal(untrack(() => params.q || ''));
  usePageTitle('Artists · Pokoin');

  const shown = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) return data.artists;
    return data.artists.filter((row) => row.name.toLowerCase().includes(needle));
  });
  const totals = data.totals;

  return (
    <div class="sanitize">
      <BoardBar host={`pokoin.com · artists · ${data.revision}`} />

      <main class="sanitize-main ocr-main">
        <p class="sanitize-kicker">PP-OCRv5 Illus. · pokemontcg.io names</p>
        <h1>Pokémon card artists</h1>
        <p class="sanitize-lead">
          {totals.withArtist.toLocaleString('en-US')} of {totals.cards.toLocaleString('en-US')} western
          scans have an illustrator. Garbled OCR credits map to pokemontcg.io
          when they match. Flavor-text OCR is not an artist.
          Same CLIP artwork copies a real illustrator onto JP/CN reprints in the
          {' '}
          <a class="linkish" href="/marketplace/en/artists">catalog artists</a>
          {' '}
          grid.
        </p>
        <p class="sanitize-note">{data.rule}</p>

        <div class="ocr-filters">
          <p class="result-count">
            <strong>{shown().length}</strong> artists
            {shown().length !== totals.unique ? ` of ${totals.unique}` : ''}
          </p>
          <input
            type="search"
            value={query()}
            onInput={(event) => {
              const next = event.currentTarget.value;
              setQuery(next);
              setParams({ q: next.trim() || undefined }, { replace: true });
            }}
            placeholder="Filter artists…"
            aria-label="Filter artists"
          />
        </div>

        <div class="ocr-artist-wrap">
          <table class="ocr-artist-table">
            <thead>
              <tr>
                <th>Artist</th>
                <th>Cards</th>
                <th>Source</th>
                <th>Example cards</th>
              </tr>
            </thead>
            <tbody>
              <For each={shown()}>
                {(row) => (
                  <tr>
                    <td>
                      <Show when={row.matched} fallback={row.name}>
                        <a href={`/marketplace/en/artists/${row.slug}`}>{row.name}</a>
                      </Show>
                    </td>
                    <td>{row.count.toLocaleString('en-US')}</td>
                    <td>{row.matched ? 'pokemontcg.io' : 'OCR'}</td>
                    <td>
                      <For each={row.cards}>
                        {(card, index) => (
                          <span>
                            {index() ? ' · ' : null}
                            <a href={`/marketplace/en/cards/${card.card_id}`}>{card.name}</a>
                          </span>
                        )}
                      </For>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </main>
      <TestDock />
    </div>
  );
}
