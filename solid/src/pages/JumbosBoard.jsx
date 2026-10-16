import { For } from 'solid-js';
import jumbos from '@market/../public/review/jumbos.json';
import TestDock from '../components/TestDock.jsx';
import { BoardBar, usePageTitle } from './tools/board.jsx';

/** Visual review of every Jumbo Oversized leftover: homepage thumb with the
 * full-resolution JPEG one click away. A red outline means a broken image.
 * */
export default function JumbosBoard() {
  usePageTitle('Jumbos · test.pokoin.com');

  return (
    <div class="sanitize jumbos-board">
      <BoardBar host="test.pokoin.com · jumbos" />

      <main class="sanitize-main">
        <p class="sanitize-kicker">Internal review boards</p>
        <h1>Jumbo Oversized</h1>
        <p class="sanitize-lead">
          All {jumbos.count} Jumbo Oversized leftovers across {jumbos.sets.length} sets,
          revision {jumbos.revision}. Thumbnails are the same homepage tiles the site
          serves; a red outline means the image failed to load.
        </p>

        <For each={jumbos.sets}>
          {(set) => (
            <section class="jumbos-set">
              <h2>{set.set} <small>({set.cards.length})</small></h2>
              <div class="jumbos-grid">
                <For each={set.cards}>
                  {(card) => (
                    <figure>
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
                        <span class="jumbos-num">{card.number}</span>
                        <span class="jumbos-id">id {card.id}</span>
                      </figcaption>
                    </figure>
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </main>

      <TestDock />
    </div>
  );
}
