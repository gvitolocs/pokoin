import { useEffect } from 'react';
import TestDock from '../components/TestDock.jsx';

const VIDEOS = [
  { id: 'en', label: 'English · excited', lang: 'en', src: 'https://cdn.pokoin.com/poko-video/ep5/poko_30th_excited_en_720p.mp4' },
  { id: 'it', label: 'Italiano · entusiasta', lang: 'it', src: 'https://cdn.pokoin.com/poko-video/ep5/poko_30th_excited_it_720p.mp4' },
  { id: 'before', label: 'English · before (Alloy Turbo)', lang: 'en', src: 'https://cdn.pokoin.com/poko-video/ep5/poko_30th_alloy_turbo_en_720p.mp4' },
];
const POSTER = 'https://cdn.pokoin.com/poko-video/ep5/poster.jpg';

/** Side-by-side review of the re-voiced Poko Part 5 episode: the new English
 * and Italian excited voices, plus the previous Alloy Turbo voice for A/B. */
export default function PokoVideoBoard() {
  useEffect(() => {
    document.title = 'Poko · test.pokoin.com';
  }, []);

  return (
    <div className="sanitize poko-video-board">
      <header className="sanitize-bar">
        <a className="brand" href="https://pokoin.com/" aria-label="Pokoin">
          <img src="/home/logo.png" alt="" width="40" height="40" />
          <span>Pokoin</span>
        </a>
        <p className="sanitize-host">test.pokoin.com · poko</p>
      </header>

      <main className="sanitize-main">
        <p className="sanitize-kicker">Internal review boards</p>
        <h1>Poko Part 5 — Pokémon 30th Celebration</h1>
        <p className="sanitize-lead">
          Kids episode re-voiced with Azure Dragon HD Omni in the excited style:
          English uses the same Alloy timbre as before, Italian uses the native
          it-IT Alessio voice. The last player is the previous Alloy Turbo voice
          for comparison.
        </p>

        {VIDEOS.map((v) => (
          <section className="poko-video" key={v.id} lang={v.lang}>
            <h2>{v.label}</h2>
            <video controls preload="metadata" playsInline poster={POSTER} src={v.src} />
            <p><a href={v.src} target="_blank" rel="noopener noreferrer">Open MP4</a></p>
          </section>
        ))}
      </main>

      <TestDock />
    </div>
  );
}
