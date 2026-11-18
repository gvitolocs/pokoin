import { createMemo, createSignal, For, onSettled, Show } from 'solid-js';
import TestDock from '../components/TestDock.jsx';
import { BoardBar, usePageTitle } from './tools/board.jsx';

const CATALOG_URL = 'https://cdn.pokoin.com/poko-video/newpoko/catalog.json';

/** newPoko Gemini Fenrir voice archive — dataset phrases + remade episode lines.
 * */
export default function PokoArchive() {
  const [catalog, setCatalog] = createSignal(null);
  const [error, setError] = createSignal('');
  const [groupId, setGroupId] = createSignal('');
  const [q, setQ] = createSignal('');
  usePageTitle('newPoko archive · test.pokoin.com');

  onSettled(() => {
    let cancelled = false;
    fetch(CATALOG_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`catalog ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setCatalog(() => data);
        setGroupId(data.groups?.[0]?.id || '');
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message || e));
      });
    return () => { cancelled = true; };
  });

  const group = createMemo(() => (catalog()?.groups || []).find((g) => g.id === groupId()) || null);
  const files = createMemo(() => {
    const current = group();
    if (!current) return [];
    const needle = q().trim().toLowerCase();
    if (!needle) return current.files;
    return current.files.filter((f) => `${f.id} ${f.text || ''}`.toLowerCase().includes(needle));
  });

  return (
    <div class="sanitize poko-archive">
      <BoardBar host="test.pokoin.com · poko / archive" />

      <main class="sanitize-main">
        <p class="sanitize-kicker">Internal review boards</p>
        <h1>newPoko voice archive</h1>
        <p class="sanitize-lead">
          Gemini 3.8 Flash TTS · Fenrir. Dataset phrases (EN/IT) plus remade
          episode narration lines (EN ep1–ep7), each as its own take with script text.
        </p>

        <Show when={error()}><p class="sanitize-note">Failed to load catalog: {error()}</p></Show>
        <Show when={!catalog() && !error()}><p class="sanitize-note">Loading catalog…</p></Show>

        <Show when={catalog()}>
          {(cat) => (
            <>
              <p class="sanitize-note">
                {cat().total_files} clips · {cat().voice} · speaker {cat().speaker}
              </p>

              <div class="poko-tiles poko-groups" role="tablist" aria-label="Catalog groups">
                <For each={cat().groups || []}>
                  {(g) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={String(g.id === groupId())}
                      class={{ on: g.id === groupId() }}
                      onClick={() => setGroupId(g.id)}
                    >
                      <strong>{g.title}</strong>
                      <span>{g.count} clips</span>
                    </button>
                  )}
                </For>
              </div>

              <div class="poko-archive-controls" role="group" aria-label="Archive filters">
                <label>
                  Search
                  <input
                    type="search"
                    value={q()}
                    onInput={(e) => setQ(e.currentTarget.value)}
                    placeholder="id or script text"
                  />
                </label>
                <Show when={group()?.script}>
                  <a class="poko-archive-script" href={group().script} target="_blank" rel="noopener noreferrer">
                    Open script
                  </a>
                </Show>
                <span class="poko-controls-count">{files().length} of {group()?.count ?? 0} clips</span>
              </div>

              <ol class="poko-tiles poko-clips">
                <For each={files()}>
                  {(f) => (
                    <li class="poko-tile">
                      <div class="poko-tile-meta">
                        <code>{f.id}</code>
                        <Show when={f.lang}><span class="poko-chip">{f.lang}</span></Show>
                        <Show when={f.episode}><span class="poko-chip">{f.episode}</span></Show>
                        <Show when={f.duration_s != null}>
                          <span class="poko-tile-duration">{Number(f.duration_s).toFixed(2)}s</span>
                        </Show>
                      </div>
                      <Show when={f.text} fallback={<p class="poko-tile-text is-empty">no transcript yet</p>}>
                        <p class="poko-tile-text" title={f.text}>{f.text}</p>
                      </Show>
                      <audio controls preload="none" src={f.src} />
                    </li>
                  )}
                </For>
              </ol>
              <Show when={!files().length}><p class="sanitize-note">No clips match this filter.</p></Show>
            </>
          )}
        </Show>
      </main>

      <TestDock />
    </div>
  );
}
