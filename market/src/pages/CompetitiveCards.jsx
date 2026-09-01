import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import CardArt from '../components/CardArt.jsx';
import CompetitiveNav from '../components/CompetitiveNav.jsx';
import { competitiveData, scanUrl } from '../competitive.js';

function CardsList() {
  const data = competitiveData();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get('q') || '');
  const q = (params.get('q') || '').toLowerCase();
  const rows = useMemo(() => (
    data.cards.filter((card) => !q || `${card.name} ${card.set} ${card.num} ${card.type}`.toLowerCase().includes(q))
  ), [data.cards, q]);

  useEffect(() => {
    document.title = 'Competitive cards · Pokoin';
  }, []);

  function submit(event) {
    event.preventDefault();
    setParams(query.trim() ? { q: query.trim() } : {});
  }

  return (
    <div className="page comp-page">
      <CompetitiveNav />
      <form className="comp-toolbar" onSubmit={submit}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search snapshot cards"
          aria-label="Search competitive cards"
        />
        <button className="more" type="submit" style={{ margin: 0 }}>Search</button>
      </form>
      <div className="comp-card-grid">
        {rows.map((card) => (
          <Link className="comp-card-tile" key={card.id} to={`/marketplace/competitive/cards/${card.id}`}>
            <CardArt src={scanUrl(card.set, card.num)} alt={card.name} />
            <strong>{card.name}</strong>
            <span className="muted">{card.set} {card.num} · {card.type}</span>
          </Link>
        ))}
      </div>
      {rows.length ? null : <p className="muted">No cards match that search.</p>}
    </div>
  );
}

function CardDetail() {
  const { cardId } = useParams();
  const data = competitiveData();
  const card = data.cards.find((row) => row.id === cardId) || null;
  const used = card
    ? data.decks.filter((deck) => deck.name.toLowerCase().includes(String(card.name).split(' ')[0].toLowerCase()))
    : [];

  useEffect(() => {
    document.title = `${card?.name || 'Card'} · Pokoin`;
  }, [card]);

  if (!card) {
    return (
      <div className="page comp-page">
        <CompetitiveNav />
        <p className="status error">That card is not in the snapshot.</p>
      </div>
    );
  }

  return (
    <div className="page comp-page">
      <CompetitiveNav />
      <nav className="crumbs">
        <Link to="/marketplace/competitive/cards">Cards</Link>
        <span>/</span>
        <span>{card.name}</span>
      </nav>
      <div className="comp-card-hero">
        <CardArt src={scanUrl(card.set, card.num)} alt={card.name} />
        <div>
          <h1>{card.name}</h1>
          <p className="muted">
            {card.set} {card.num}
            {card.hp ? ` · ${card.hp} HP` : ''}
            {' · '}
            {card.type}
            {' · '}
            {card.rarity}
          </p>
          <p>
            <Link to={`/marketplace/search?q=${encodeURIComponent(card.name)}`}>Search marketplace</Link>
          </p>
          <h2>Used in archetypes</h2>
          {used.length ? (
            <div className="comp-table-wrap">
              <table className="comp-table">
                <thead>
                  <tr>
                    <th>Deck</th>
                    <th>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {used.map((deck) => (
                    <tr key={deck.id}>
                      <td>
                        <Link to={`/marketplace/competitive/decks/${deck.id}`}>{deck.name}</Link>
                      </td>
                      <td>{deck.share.toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">No archetype usage in this snapshot.</p>}
        </div>
      </div>
    </div>
  );
}

export default function CompetitiveCards() {
  const { cardId } = useParams();
  return cardId ? <CardDetail /> : <CardsList />;
}
