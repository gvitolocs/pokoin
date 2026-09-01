import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import CardArt from '../components/CardArt.jsx';
import CompetitiveNav from '../components/CompetitiveNav.jsx';
import {
  FORMAT,
  competitiveData,
  completedTournaments,
  listById,
  scanUrl,
  upcomingTournaments,
} from '../competitive.js';

function EventRow({ event }) {
  return (
    <Link className="event-row" to={`/marketplace/competitive/tournaments/${event.id}`}>
      <span>
        <strong>{event.name}</strong>
        <small>
          {event.date}
          {event.players ? ` · ${event.players} players` : ''}
        </small>
      </span>
      {event.format ? <CardArt className="comp-badge" src={FORMAT(event.format)} alt="" fallback="hide" /> : null}
    </Link>
  );
}

export default function Competitive() {
  const data = competitiveData();
  const featured = data.decks.filter((deck) => deck.featured).slice(0, 6);
  const recent = completedTournaments().slice(0, 6);
  const upcoming = upcomingTournaments();
  const leagues = data.cityLeagues;

  useEffect(() => {
    document.title = 'Competitive · Pokoin';
  }, []);

  return (
    <div className="page comp-page">
      <CompetitiveNav />
      <section>
        <div className="carousel-head">
          <h2>Top decks ({data.format})</h2>
          <Link className="see-all" to="/marketplace/competitive/decks">All decks</Link>
        </div>
        <div className="comp-leaders">
          {featured.map((deck, index) => (
            <article key={deck.id} className="comp-leader">
              <Link to={`/marketplace/competitive/decks/${deck.id}`}>
                <CardArt src={scanUrl(deck.set, deck.num)} alt={deck.name} />
                <strong>{index + 1}. {deck.short}</strong>
                <em>{deck.share.toFixed(2)}%</em>
              </Link>
              {deck.featured ? (
                listById(deck.featured.list) ? (
                  <Link className="comp-feat" to={`/marketplace/competitive/decklists/${deck.featured.list}`}>
                    Featured · {deck.featured.place} {deck.featured.event} — {deck.featured.player}
                  </Link>
                ) : (
                  <span className="comp-feat">
                    Featured · {deck.featured.place} {deck.featured.event} — {deck.featured.player}
                  </span>
                )
              ) : null}
            </article>
          ))}
        </div>
      </section>
      <div className="comp-split">
        <section>
          <div className="carousel-head">
            <h2>Recent tournaments</h2>
            <Link className="see-all" to="/marketplace/competitive/tournaments">All completed</Link>
          </div>
          <div className="event-list">
            {recent.map((event) => <EventRow key={event.id} event={event} />)}
          </div>
        </section>
        <section>
          <div className="carousel-head">
            <h2>Upcoming</h2>
            <Link className="see-all" to="/marketplace/competitive/tournaments?tab=upcoming">All upcoming</Link>
          </div>
          <div className="event-list">
            {upcoming.map((event) => <EventRow key={event.id} event={event} />)}
          </div>
          <div className="carousel-head" style={{ marginTop: '1.5rem' }}>
            <h2>City leagues</h2>
            <Link className="see-all" to="/marketplace/competitive/tournaments?tab=city">All leagues</Link>
          </div>
          <div className="event-list">
            {leagues.map((event) => <EventRow key={event.id} event={event} />)}
          </div>
        </section>
      </div>
      <section>
        <div className="carousel-head">
          <h2>Notes</h2>
        </div>
        <p className="muted">
          This page is the candyext Limitless dump ({data.formatLabel}): {data.tournaments.length} events,
          {' '}{data.decks.length} archetypes, Worlds standings, and {Object.keys(data.lists).length} representative lists.
          It is not a live Limitless scrape and not Oracle `/api/marketplace-competitive`.
        </p>
      </section>
    </div>
  );
}
