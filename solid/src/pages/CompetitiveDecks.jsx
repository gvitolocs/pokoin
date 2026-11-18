import { createMemo, createSignal, For, Show } from 'solid-js';
import { useParams } from '@solidjs/router';
import { competitiveData, deckById, placeSuffix, scanUrl, tournamentById } from '@market/competitive.js';
import CardArt from '../components/CardArt.jsx';
import CompetitiveNav, { NotInSnapshot, Sprite } from '../components/CompetitiveNav.jsx';
import { DeskPanel } from '../components/Desk.jsx';
import { gameHref } from '@market/game.js';

function DecksList() {
  const data = competitiveData();
  const [rank, setRank] = createSignal('points');
  const rows = createMemo(() => (
    [...data.decks].sort((a, b) => (rank() === 'share' ? b.share - a.share : b.points - a.points))
  ));

  document.title = 'Decks · Pokoin';

  return (
    <div class="page desk comp-page">
      <CompetitiveNav />
      <div class="shop-toolbar">
        <p class="result-count"><strong>{rows().length}</strong> decks · {data.format}</p>
        <select value={rank()} onChange={(event) => setRank(event.currentTarget.value)} aria-label="Rank by">
          <option value="points">Points</option>
          <option value="share">Share</option>
        </select>
      </div>
      <DeskPanel flush>
        <div class="comp-table-wrap">
          <table class="comp-table">
            <thead>
              <tr>
                <th>#</th>
                <th> </th>
                <th>Deck</th>
                <th class="num">Points</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(deck, index) => (
                  <tr>
                    <td>{index() + 1}</td>
                    <td><Sprite deck={deck} /></td>
                    <td>
                      <a href={gameHref(`/marketplace/competitive/decks/${deck.id}`)}>{deck.name}</a>
                    </td>
                    <td class="num">{deck.points}</td>
                    <td>
                      <span class="comp-share">
                        {deck.share.toFixed(2)}%
                        <span class="share-bar"><i style={{ width: `${Math.min(100, deck.share * 2.2)}%` }} /></span>
                      </span>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </DeskPanel>
    </div>
  );
}

function DeckDetail(props) {
  const data = competitiveData();
  const deck = props.deck;
  const lists = Object.values(data.lists).filter((row) => row.deck === deck.id);
  const results = Object.entries(data.standings).flatMap(([tid, rows]) => (
    rows.filter((row) => row.deck === deck.id).map((row) => ({ ...row, tid }))
  ));

  document.title = `${deck.name || 'Deck'} · Pokoin`;

  return (
    <div class="page desk comp-page">
      <CompetitiveNav />
      <nav class="crumbs">
        <a href={gameHref('/marketplace/competitive/decks')}>Decks</a>
        <span>/</span>
        <span>{deck.name}</span>
      </nav>
      <header class="comp-infobox">
        <div class="comp-deck-hero">
          <CardArt src={scanUrl(deck.set, deck.num)} alt={deck.name} />
          <div>
            <h1>{deck.name}</h1>
            <p class="muted">{deck.points} points · {deck.share.toFixed(2)}% share · {data.format}</p>
          </div>
        </div>
      </header>
      <section>
        <h2>Recent results</h2>
        <Show when={results.length} fallback={<p class="muted">No results in this snapshot.</p>}>
          <div class="comp-table-wrap">
            <table class="comp-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Tournament</th>
                </tr>
              </thead>
              <tbody>
                <For each={results}>
                  {(row) => (
                    <tr>
                      <td>{row.place}</td>
                      <td>
                        <a href={gameHref(`/marketplace/competitive/players/${row.playerId}`)}>{row.player}</a>
                      </td>
                      <td>
                        <a href={gameHref(`/marketplace/competitive/tournaments/${row.tid}`)}>{tournamentById(row.tid)?.name || row.tid}</a>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </section>
      <section>
        <h2>Featured lists</h2>
        <Show when={lists.length} fallback={<p class="muted">Open a Worlds list from standings.</p>}>
          <div class="comp-table-wrap">
            <table class="comp-table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Event</th>
                </tr>
              </thead>
              <tbody>
                <For each={lists}>
                  {(row) => (
                    <tr>
                      <td>
                        <a href={gameHref(`/marketplace/competitive/decklists/${row.id}`)}>{row.player}</a>
                      </td>
                      <td>{tournamentById(row.event)?.name || ''} · {row.place}{placeSuffix(row.place)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </section>
    </div>
  );
}

function Missing() {
  document.title = 'Deck · Pokoin';
  return <NotInSnapshot>That deck is not in the snapshot.</NotInSnapshot>;
}

/** /marketplace/competitive/decks[/:deckId]. */
export default function CompetitiveDecks() {
  const params = useParams();
  return (
    <Show when={params.deckId} fallback={<DecksList />}>
      <Show when={deckById(params.deckId)} keyed fallback={<Missing />}>
        {(deck) => <DeckDetail deck={deck} />}
      </Show>
    </Show>
  );
}
