import { createMemo, createSignal, For, Show } from 'solid-js';
import { useParams } from '@solidjs/router';
import { competitiveData, money, playerById, tournamentById } from '@market/competitive.js';
import CompetitiveNav, { Flag, NotInSnapshot } from '../components/CompetitiveNav.jsx';
import { DeskPanel } from '../components/Desk.jsx';

const RANKS = [
  ['points', 'Points'],
  ['earnings', 'Earnings'],
  ['day2', 'Day 2 finishes'],
  ['top8', 'Top 8 finishes'],
  ['wins', 'Tournament wins'],
];

function PlayersList() {
  const data = competitiveData();
  const [rank, setRank] = createSignal('points');
  const rows = createMemo(() => [...data.players].sort((a, b) => (b[rank()] || 0) - (a[rank()] || 0)));

  document.title = 'Rankings · Pokoin';

  return (
    <div class="page desk comp-page">
      <CompetitiveNav />
      <div class="shop-toolbar">
        <p class="result-count"><strong>{rows().length}</strong> players</p>
        <select value={rank()} onChange={(event) => setRank(event.currentTarget.value)} aria-label="Rank by">
          <For each={RANKS}>
            {([value, label]) => <option value={value}>{label}</option>}
          </For>
        </select>
      </div>
      <DeskPanel flush>
        <div class="comp-table-wrap">
          <table class="comp-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th class="num">Points</th>
                <th class="num">Earnings</th>
                <th class="num">Day 2</th>
                <th class="num">Top 8</th>
                <th class="num">Wins</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(player, index) => (
                  <tr>
                    <td>{index() + 1}</td>
                    <td>
                      <a href={`/marketplace/competitive/players/${player.id}`}>
                        <Flag cc={player.flag} />
                        {player.name}
                      </a>
                    </td>
                    <td class="num">{player.points}</td>
                    <td class="num">{money(player.earnings)}</td>
                    <td class="num">{player.day2}</td>
                    <td class="num">{player.top8}</td>
                    <td class="num">{player.wins}</td>
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

function PlayerDetail(props) {
  const data = competitiveData();
  const player = props.player;
  const results = Object.entries(data.standings).flatMap(([tid, rows]) => (
    rows.filter((row) => row.playerId === String(player.id)).map((row) => ({ ...row, tid }))
  ));

  document.title = `${player.name || 'Player'} · Pokoin`;

  return (
    <div class="page desk comp-page">
      <CompetitiveNav />
      <nav class="crumbs">
        <a href="/marketplace/competitive/players">Rankings</a>
        <span>/</span>
        <span>{player.name}</span>
      </nav>
      <header class="comp-infobox">
        <h1>
          <Flag cc={player.flag} />
          {player.name}
        </h1>
        <p class="muted">
          {player.points} points · {money(player.earnings)} · {player.wins} wins · {player.region}
        </p>
      </header>
      <section>
        <h2>Results in snapshot</h2>
        <Show when={results.length} fallback={<p class="muted">No standings rows for this player in the snapshot.</p>}>
          <div class="comp-table-wrap">
            <table class="comp-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Tournament</th>
                  <th>Deck</th>
                </tr>
              </thead>
              <tbody>
                <For each={results}>
                  {(row) => (
                    <tr>
                      <td>{row.place}</td>
                      <td>
                        <a href={`/marketplace/competitive/tournaments/${row.tid}`}>{tournamentById(row.tid)?.name || row.tid}</a>
                      </td>
                      <td>
                        <Show when={row.list} fallback="—">
                          <a href={`/marketplace/competitive/decklists/${row.list}`}>List {row.list}</a>
                        </Show>
                      </td>
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
  document.title = 'Player · Pokoin';
  return <NotInSnapshot>That player is not in the snapshot.</NotInSnapshot>;
}

/** /marketplace/competitive/players[/:playerId]. */
export default function CompetitivePlayers() {
  const params = useParams();
  return (
    <Show when={params.playerId} fallback={<PlayersList />}>
      <Show when={playerById(params.playerId)} keyed fallback={<Missing />}>
        {(player) => <PlayerDetail player={player} />}
      </Show>
    </Show>
  );
}
