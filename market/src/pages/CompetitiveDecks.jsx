import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import CardArt from '../components/CardArt.jsx';
import CompetitiveNav from '../components/CompetitiveNav.jsx';
import {
  SPRITE,
  competitiveData,
  deckById,
  placeSuffix,
  scanUrl,
  tournamentById,
} from '../competitive.js';

function DecksList() {
  const data = competitiveData();
  const [rank, setRank] = useState('points');
  const rows = useMemo(() => (
    [...data.decks].sort((a, b) => (rank === 'share' ? b.share - a.share : b.points - a.points))
  ), [data.decks, rank]);

  useEffect(() => {
    document.title = 'Decks · Pokoin';
  }, []);

  return (
    <div className="page comp-page">
      <CompetitiveNav />
      <div className="comp-toolbar">
        <label className="sort">
          Rank by
          <select value={rank} onChange={(event) => setRank(event.target.value)}>
            <option value="points">Points</option>
            <option value="share">Share</option>
          </select>
        </label>
        <span className="muted">Format: {data.format}</span>
      </div>
      <div className="comp-table-wrap">
        <table className="comp-table">
          <thead>
            <tr>
              <th>#</th>
              <th> </th>
              <th>Deck</th>
              <th className="num">Points</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((deck, index) => (
              <tr key={deck.id}>
                <td>{index + 1}</td>
                <td>
                  {deck.sprite ? <CardArt className="comp-sprite" src={SPRITE(deck.sprite)} alt="" fallback="hide" /> : null}
                </td>
                <td>
                  <Link to={`/marketplace/competitive/decks/${deck.id}`}>{deck.name}</Link>
                </td>
                <td className="num">{deck.points}</td>
                <td>
                  <span className="comp-share">
                    {deck.share.toFixed(2)}%
                    <span className="share-bar"><i style={{ width: `${Math.min(100, deck.share * 2.2)}%` }} /></span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DeckDetail() {
  const { deckId } = useParams();
  const data = competitiveData();
  const deck = deckById(deckId);
  const lists = Object.values(data.lists).filter((row) => row.deck === deck?.id);
  const results = Object.entries(data.standings).flatMap(([tid, rows]) => (
    rows.filter((row) => row.deck === deck?.id).map((row) => ({ ...row, tid }))
  ));

  useEffect(() => {
    document.title = `${deck?.name || 'Deck'} · Pokoin`;
  }, [deck]);

  if (!deck) {
    return (
      <div className="page comp-page">
        <CompetitiveNav />
        <p className="status error">That deck is not in the snapshot.</p>
      </div>
    );
  }

  return (
    <div className="page comp-page">
      <CompetitiveNav />
      <nav className="crumbs">
        <Link to="/marketplace/competitive/decks">Decks</Link>
        <span>/</span>
        <span>{deck.name}</span>
      </nav>
      <header className="comp-infobox">
        <div className="comp-deck-hero">
          <CardArt src={scanUrl(deck.set, deck.num)} alt={deck.name} />
          <div>
            <h1>{deck.name}</h1>
            <p className="muted">{deck.points} points · {deck.share.toFixed(2)}% share · {data.format}</p>
          </div>
        </div>
      </header>
      <section>
        <h2>Recent results</h2>
        {results.length ? (
          <div className="comp-table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Tournament</th>
                </tr>
              </thead>
              <tbody>
                {results.map((row) => {
                  const event = tournamentById(row.tid);
                  return (
                    <tr key={`${row.tid}-${row.playerId}-${row.place}`}>
                      <td>{row.place}</td>
                      <td>
                        <Link to={`/marketplace/competitive/players/${row.playerId}`}>{row.player}</Link>
                      </td>
                      <td>
                        <Link to={`/marketplace/competitive/tournaments/${row.tid}`}>{event?.name || row.tid}</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">No results in this snapshot.</p>}
      </section>
      <section>
        <h2>Featured lists</h2>
        {lists.length ? (
          <div className="comp-table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Event</th>
                </tr>
              </thead>
              <tbody>
                {lists.map((row) => {
                  const event = tournamentById(row.event);
                  return (
                    <tr key={row.id}>
                      <td>
                        <Link to={`/marketplace/competitive/decklists/${row.id}`}>{row.player}</Link>
                      </td>
                      <td>{event?.name || ''} · {row.place}{placeSuffix(row.place)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">Open a Worlds list from standings.</p>}
      </section>
    </div>
  );
}

export default function CompetitiveDecks() {
  const { deckId } = useParams();
  return deckId ? <DeckDetail /> : <DecksList />;
}
