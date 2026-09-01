import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import CardArt from '../components/CardArt.jsx';
import CompetitiveNav from '../components/CompetitiveNav.jsx';
import {
  FLAG,
  competitiveData,
  money,
  playerById,
  tournamentById,
} from '../competitive.js';

function Flag({ cc }) {
  return cc ? <CardArt className="comp-flag" src={FLAG(cc)} alt={cc} fallback="hide" /> : null;
}

function PlayersList() {
  const data = competitiveData();
  const [rank, setRank] = useState('points');
  const rows = [...data.players].sort((a, b) => (b[rank] || 0) - (a[rank] || 0));

  useEffect(() => {
    document.title = 'Rankings · Pokoin';
  }, []);

  return (
    <div className="page comp-page">
      <CompetitiveNav />
      <div className="comp-toolbar">
        <label className="sort">
          Rank by
          <select value={rank} onChange={(event) => setRank(event.target.value)}>
            <option value="points">Points</option>
            <option value="earnings">Earnings</option>
            <option value="day2">Day 2 finishes</option>
            <option value="top8">Top 8 finishes</option>
            <option value="wins">Tournament wins</option>
          </select>
        </label>
      </div>
      <div className="comp-table-wrap">
        <table className="comp-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th className="num">Points</th>
              <th className="num">Earnings</th>
              <th className="num">Day 2</th>
              <th className="num">Top 8</th>
              <th className="num">Wins</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((player, index) => (
              <tr key={player.id}>
                <td>{index + 1}</td>
                <td>
                  <Link to={`/marketplace/competitive/players/${player.id}`}>
                    <Flag cc={player.flag} />
                    {player.name}
                  </Link>
                </td>
                <td className="num">{player.points}</td>
                <td className="num">{money(player.earnings)}</td>
                <td className="num">{player.day2}</td>
                <td className="num">{player.top8}</td>
                <td className="num">{player.wins}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlayerDetail() {
  const { playerId } = useParams();
  const data = competitiveData();
  const player = playerById(playerId);
  const results = Object.entries(data.standings).flatMap(([tid, rows]) => (
    rows.filter((row) => row.playerId === String(playerId)).map((row) => ({ ...row, tid }))
  ));

  useEffect(() => {
    document.title = `${player?.name || 'Player'} · Pokoin`;
  }, [player]);

  if (!player) {
    return (
      <div className="page comp-page">
        <CompetitiveNav />
        <p className="status error">That player is not in the snapshot.</p>
      </div>
    );
  }

  return (
    <div className="page comp-page">
      <CompetitiveNav />
      <nav className="crumbs">
        <Link to="/marketplace/competitive/players">Rankings</Link>
        <span>/</span>
        <span>{player.name}</span>
      </nav>
      <header className="comp-infobox">
        <h1>
          <Flag cc={player.flag} />
          {player.name}
        </h1>
        <p className="muted">
          {player.points} points · {money(player.earnings)} · {player.wins} wins · {player.region}
        </p>
      </header>
      <section>
        <h2>Results in snapshot</h2>
        {results.length ? (
          <div className="comp-table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Tournament</th>
                  <th>Deck</th>
                </tr>
              </thead>
              <tbody>
                {results.map((row) => {
                  const event = tournamentById(row.tid);
                  return (
                    <tr key={`${row.tid}-${row.place}`}>
                      <td>{row.place}</td>
                      <td>
                        <Link to={`/marketplace/competitive/tournaments/${row.tid}`}>{event?.name || row.tid}</Link>
                      </td>
                      <td>
                        {row.list ? (
                          <Link to={`/marketplace/competitive/decklists/${row.list}`}>List {row.list}</Link>
                        ) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">No standings rows for this player in the snapshot.</p>}
      </section>
    </div>
  );
}

export default function CompetitivePlayers() {
  const { playerId } = useParams();
  return playerId ? <PlayerDetail /> : <PlayersList />;
}
