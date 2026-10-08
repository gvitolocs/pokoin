import { useEffect, useMemo, useState } from 'react';
import TestDock from '../components/TestDock.jsx';

const CATALOG_URL = 'https://cdn.pokoin.com/poko-video/newpoko/catalog.json';

/** newPoko Gemini Fenrir voice archive — dataset phrases + remade episode lines. */
export default function PokoArchive() {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [groupId, setGroupId] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    document.title = 'newPoko archive · test.pokoin.com';
    let cancelled = false;
    fetch(CATALOG_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`catalog ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setCatalog(data);
        setGroupId(data.groups?.[0]?.id || '');
      })
      .catch((e) => {
        if (!cancelled) setError(String(e.message || e));
      });
    return () => { cancelled = true; };
  }, []);

  const group = useMemo(
    () => (catalog?.groups || []).find((g) => g.id === groupId) || null,
    [catalog, groupId],
  );

  const files = useMemo(() => {
    if (!group) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return group.files;
    return group.files.filter((f) =>
      `${f.id} ${f.text || ''}`.toLowerCase().includes(needle));
  }, [group, q]);

  return (
    <div className="sanitize poko-archive">
      <header className="sanitize-bar">
        <a className="brand" href="https://pokoin.com/" aria-label="Pokoin">
          <img src="/home/logo.png" alt="" width="40" height="40" />
          <span>Pokoin</span>
        </a>
        <p className="sanitize-host">test.pokoin.com · poko / archive</p>
      </header>

      <main className="sanitize-main">
        <p className="sanitize-kicker">Internal review boards</p>
        <h1>newPoko voice archive</h1>
        <p className="sanitize-lead">
          Gemini 3.8 Flash TTS · Fenrir. Dataset phrases (EN/IT) plus remade
          episode narration lines (EN ep1–ep7), each as its own take with script text.
        </p>

        {error ? <p className="sanitize-note">Failed to load catalog: {error}</p> : null}
        {!catalog && !error ? <p className="sanitize-note">Loading catalog…</p> : null}

        {catalog ? (
          <>
            <p className="sanitize-note">
              {catalog.total_files} clips · {catalog.voice} · speaker {catalog.speaker}
            </p>

            <div className="poko-archive-controls" role="group" aria-label="Archive filters">
              <label>
                Group
                <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                  {(catalog.groups || []).map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.title} ({g.count})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Search
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="id or script text"
                />
              </label>
              {group?.script ? (
                <a className="poko-archive-script" href={group.script} target="_blank" rel="noopener noreferrer">
                  Open script
                </a>
              ) : null}
            </div>

            <ol className="poko-archive-list">
              {files.map((f) => (
                <li key={f.id} className="poko-archive-row">
                  <div className="poko-archive-meta">
                    <code>{f.id}</code>
                    {f.lang ? <span className="poko-archive-lang">{f.lang}</span> : null}
                    {f.episode ? <span className="poko-archive-ep">{f.episode}</span> : null}
                    {f.duration_s != null ? <span>{Number(f.duration_s).toFixed(2)}s</span> : null}
                  </div>
                  <p className="poko-archive-text">{f.text || '—'}</p>
                  <audio controls preload="none" src={f.src} />
                </li>
              ))}
            </ol>
            {!files.length ? <p className="sanitize-note">No clips match this filter.</p> : null}
          </>
        ) : null}
      </main>

      <TestDock />
    </div>
  );
}
