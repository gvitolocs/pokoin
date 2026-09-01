import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import CompetitiveNav from '../components/CompetitiveNav.jsx';
import {
  cardHrefForName,
  deckById,
  listById,
  placeSuffix,
  tournamentById,
} from '../competitive.js';

function Column({ title, rows }) {
  const count = (rows || []).reduce((sum, [qty]) => sum + Number(qty || 0), 0);
  return (
    <div className="deck-col">
      <h3>{title} ({count})</h3>
      {(rows || []).map(([qty, name]) => (
        <div key={`${qty}-${name}`}>
          <span className="qty">{qty}</span>
          {' '}
          <Link to={cardHrefForName(name)}>{name}</Link>
        </div>
      ))}
    </div>
  );
}

export default function CompetitiveDecklist() {
  const { decklistId } = useParams();
  const list = listById(decklistId);
  const deck = list ? deckById(list.deck) : null;
  const event = list ? tournamentById(list.event) : null;

  useEffect(() => {
    document.title = `${deck?.name || 'Decklist'} · Pokoin`;
  }, [deck]);

  if (!list) {
    return (
      <div className="page comp-page">
        <CompetitiveNav />
        <p className="status error">That decklist is not in the snapshot.</p>
      </div>
    );
  }

  return (
    <div className="page comp-page">
      <CompetitiveNav />
      <nav className="crumbs">
        <Link to="/marketplace/competitive/decks">Decks</Link>
        <span>/</span>
        <Link to={`/marketplace/competitive/decks/${list.deck}`}>{deck?.name || 'Deck'}</Link>
        <span>/</span>
        <span>List {list.id}</span>
      </nav>
      <header className="comp-infobox">
        <h1>{deck?.name || 'Decklist'}</h1>
        <p className="muted">
          {list.place}{placeSuffix(list.place)}
          {' · '}
          <Link to={`/marketplace/competitive/players/${list.playerId}`}>{list.player}</Link>
          {' · '}
          <Link to={`/marketplace/competitive/tournaments/${list.event}`}>{event?.name || list.event}</Link>
        </p>
      </header>
      <div className="decklist-main">
        <Column title="Pokémon" rows={list.pokemon} />
        <Column title="Trainer" rows={list.trainer} />
        <Column title="Energy" rows={list.energy} />
      </div>
    </div>
  );
}
