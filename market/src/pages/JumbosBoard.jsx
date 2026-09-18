import { useEffect } from 'react';
import TestDock from '../components/TestDock.jsx';
import jumbos from '../../public/review/jumbos.json';

/** Visual review of every Jumbo Oversized leftover: homepage thumb with the
 * full-resolution JPEG one click away. A red outline means a broken image. */
export default function JumbosBoard() {
  useEffect(() => {
    document.title = 'Jumbos · test.pokoin.com';
  }, []);

  return (
    <div className="sanitize jumbos-board">
      <header className="sanitize-bar">
        <a className="brand" href="https://pokoin.com/" aria-label="Pokoin">
          <img src="/home/logo.png" alt="" width="40" height="40" />
          <span>Pokoin</span>
        </a>
        <p className="sanitize-host">test.pokoin.com · jumbos</p>
      </header>

      <main className="sanitize-main">
        <p className="sanitize-kicker">Internal review boards</p>
        <h1>Jumbo Oversized</h1>
        <p className="sanitize-lead">
          All {jumbos.count} Jumbo Oversized leftovers across {jumbos.sets.length} sets,
          revision {jumbos.revision}. Thumbnails are the same homepage tiles the site
          serves; a red outline means the image failed to load.
        </p>

        {jumbos.sets.map((set) => (
          <section key={set.set} className="jumbos-set">
            <h2>{set.set} <small>({set.cards.length})</small></h2>
            <div className="jumbos-grid">
              {set.cards.map((card) => (
                <figure key={card.id}>
                  <img
                    loading="lazy"
                    src={card.webp || card.jpg}
                    alt={card.name}
                    onError={(event) => event.currentTarget.classList.add('jumbos-missing')}
                  />
                  <figcaption>
                    <a
                      href={`https://pokoin.com/marketplace/en/cards/${card.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {card.name}
                    </a>
                    <span className="jumbos-num">{card.number}</span>
                    <span className="jumbos-id">id {card.id}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        ))}
      </main>

      <TestDock />
    </div>
  );
}
