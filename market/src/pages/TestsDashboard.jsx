import { useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import TestDock from '../components/TestDock.jsx';
import tests from '../../public/review/tests.json';

// Longer "what this board is for" copy, keyed by route. Falls back to the
// dock note when a board has no entry here.
const ABOUT = {
  '/sanitize': 'Deskew and clean the leftover-print scans: bright-edge crop, rotation, and the GPU deskew variants, shown before / after.',
  '/espurr': 'Confirm the same painting is grouped across its JP / EN / CN printings so one artwork cluster stays one cluster.',
  '/ocr': 'Read expansion and print language straight off the card with Qwen3-VL on the leftover print.',
  '/ocr/artists': 'Match the OCR-read illustrator credit to the pokemontcg.io artist table.',
  '/artwork': 'Pokémon-only album hover masks: Qwen3-VL boxes → SAM 2.1 silhouettes, with the whole-silhouette before / after.',
};

export default function TestsDashboard() {
  useEffect(() => {
    document.title = 'Test boards · test.pokoin.com';
  }, []);

  const boards = tests.tests.filter((board) => board.path !== '/tests');

  return (
    <div className="sanitize tests-dashboard">
      <header className="sanitize-bar">
        <a className="brand" href="https://pokoin.com/" aria-label="Pokoin">
          <img src="/home/logo.png" alt="" width="40" height="40" />
          <span>Pokoin</span>
        </a>
        <p className="sanitize-host">test.pokoin.com · dashboard</p>
      </header>

      <main className="sanitize-main">
        <p className="sanitize-kicker">Internal review boards</p>
        <h1>Test boards</h1>
        <p className="sanitize-lead">
          One place for every review surface. Each board is a snapshot of a pipeline
          stage — open one to inspect the current output. These are internal tools,
          not production pages.
        </p>

        <section className="tests-grid" aria-label="Review boards">
          {boards.map((board) => (
            <NavLink key={board.path} to={board.path} className="tests-card">
              <div className="tests-card-head">
                <h2>{board.label}</h2>
                <time dateTime={board.date}>{board.date}</time>
              </div>
              <p className="tests-card-note">{board.note}</p>
              <p className="tests-card-about">{ABOUT[board.path] || ''}</p>
              <span className="tests-card-path">{board.path}</span>
            </NavLink>
          ))}
        </section>
      </main>

      <TestDock />
    </div>
  );
}
