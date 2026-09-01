import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import CardArt from '../components/CardArt.jsx';
import CompetitiveNav from '../components/CompetitiveNav.jsx';
import {
  ALL_FORMATS,
  ALL_REGIONS,
  ALL_TYPES,
  FLAG,
  FORMAT,
  FORMAT_LABEL,
  REGION_LABEL,
  SPRITE,
  TYPE_LABEL,
  competitiveData,
  deckById,
  filterCompleted,
  listById,
  listsForEvent,
  metaFromStandings,
  standingsFor,
  tournamentById,
  upcomingTournaments,
} from '../competitive.js';

const TABS = [
  { id: 'completed', label: 'Completed' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'city', label: 'City Leagues' },
  { id: 'online', label: 'Online' },
];

function Flag({ cc }) {
  return cc ? <CardArt className="comp-flag" src={FLAG(cc)} alt={cc} fallback="hide" /> : null;
}

function toggleIn(set, value) {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function TournamentTable({ rows, winner = true }) {
  if (!rows.length) {
    return <p className="muted">No events in this snapshot.</p>;
  }
  return (
    <div className="comp-table-wrap">
      <table className="comp-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Country</th>
            <th>Name</th>
            <th> </th>
            <th className="num">Players</th>
            {winner ? <th>Winner</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((event) => (
            <tr key={event.id}>
              <td>{event.date}</td>
              <td><Flag cc={event.country} /></td>
              <td>
                <Link to={`/marketplace/competitive/tournaments/${event.id}`}>{event.name}</Link>
              </td>
              <td>
                {event.format ? <CardArt className="comp-format" src={FORMAT(event.format)} alt={event.format} fallback="hide" /> : null}
              </td>
              <td className="num">{event.players || '—'}</td>
              {winner ? (
                <td>
                  {event.winner ? (
                    <span className="comp-winner">
                      <Flag cc={event.winnerFlag} />
                      {event.winnerId ? (
                        <Link to={`/marketplace/competitive/players/${event.winnerId}`}>{event.winner}</Link>
                      ) : event.winner}
                    </span>
                  ) : '—'}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TournamentList() {
  const data = competitiveData();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'completed';
  const [open, setOpen] = useState(false);
  const [types, setTypes] = useState(() => new Set(ALL_TYPES));
  const [formats, setFormats] = useState(() => new Set(ALL_FORMATS));
  const [regions, setRegions] = useState(() => new Set(ALL_REGIONS));

  useEffect(() => {
    document.title = 'Tournaments · Pokoin';
  }, []);

  const rows = useMemo(() => {
    if (tab === 'upcoming') return upcomingTournaments();
    if (tab === 'city') return data.cityLeagues;
    if (tab === 'online') return [];
    return filterCompleted({ types, formats, regions });
  }, [tab, types, formats, regions, data.cityLeagues]);

  return (
    <div className="page comp-page">
      <CompetitiveNav />
      <nav className="comp-tabs" aria-label="Tournament lists">
        {TABS.map((row) => (
          <button
            key={row.id}
            type="button"
            className={tab === row.id ? 'on' : undefined}
            onClick={() => setParams(row.id === 'completed' ? {} : { tab: row.id })}
          >
            {row.label}
          </button>
        ))}
      </nav>
      {tab === 'completed' ? (
        <div className="comp-filter-box">
          <button className="more" type="button" style={{ margin: '0 0 0.75rem' }} onClick={() => setOpen((value) => !value)}>
            {open ? 'Hide tournament filter' : 'Edit tournament filter'}
          </button>
          {open ? (
            <form
              className="comp-filter-grid"
              onSubmit={(event) => {
                event.preventDefault();
                setOpen(false);
              }}
            >
              <fieldset>
                <legend>Type</legend>
                {ALL_TYPES.map((type) => (
                  <label key={type}>
                    <input type="checkbox" checked={types.has(type)} onChange={() => setTypes((current) => toggleIn(current, type))} />
                    {TYPE_LABEL[type]}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>Format</legend>
                {ALL_FORMATS.map((format) => (
                  <label key={format}>
                    <input type="checkbox" checked={formats.has(format)} onChange={() => setFormats((current) => toggleIn(current, format))} />
                    {FORMAT_LABEL[format]}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>Region</legend>
                {ALL_REGIONS.map((region) => (
                  <label key={region}>
                    <input type="checkbox" checked={regions.has(region)} onChange={() => setRegions((current) => toggleIn(current, region))} />
                    {REGION_LABEL[region]}
                  </label>
                ))}
              </fieldset>
              <button className="more" type="submit" style={{ margin: 0 }}>Apply selection</button>
            </form>
          ) : (
            <p className="muted">
              Showing {rows.length} completed events
              {types.size < ALL_TYPES.length || formats.size < ALL_FORMATS.length || regions.size < ALL_REGIONS.length
                ? ' (filtered from candyext dump)'
                : ' from candyext dump'}
              .
            </p>
          )}
        </div>
      ) : null}
      {tab === 'online' ? (
        <p className="muted">No online events in this snapshot.</p>
      ) : (
        <TournamentTable rows={rows} winner={tab !== 'upcoming'} />
      )}
    </div>
  );
}

function TournamentDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const event = tournamentById(id);
  const standings = standingsFor(id);
  const lists = listsForEvent(id);
  const meta = metaFromStandings(standings);
  const data = competitiveData();
  const view = params.get('view') || 'standings';

  useEffect(() => {
    document.title = `${event?.name || 'Tournament'} · Pokoin`;
  }, [event]);

  if (!event) {
    return (
      <div className="page comp-page">
        <CompetitiveNav />
        <p className="status error">That tournament is not in the snapshot.</p>
      </div>
    );
  }

  return (
    <div className="page comp-page">
      <CompetitiveNav />
      <nav className="crumbs">
        <Link to="/marketplace/competitive/tournaments">Tournaments</Link>
        <span>/</span>
        <span>{event.name}</span>
      </nav>
      <header className="comp-infobox">
        <h1>
          <Flag cc={event.country} />
          {event.name}
        </h1>
        <p className="muted">
          {event.date}
          {event.players ? ` · ${event.players} players` : ' · Upcoming'}
          {event.type ? ` · ${TYPE_LABEL[event.type] || event.type}` : ''}
          {event.format ? ` · ${FORMAT_LABEL[event.format] || event.format}` : ''}
          {event.region ? ` · ${REGION_LABEL[event.region] || event.region}` : ''}
          {' · '}
          {data.formatLabel}
        </p>
        <p className="comp-subnav">
          <button type="button" className={view === 'standings' ? 'on' : undefined} onClick={() => setParams({})}>
            Standings
          </button>
          <button type="button" className={view === 'decklists' ? 'on' : undefined} onClick={() => setParams({ view: 'decklists' })}>
            Decklists
          </button>
          <button type="button" className={view === 'meta' ? 'on' : undefined} onClick={() => setParams({ view: 'meta' })}>
            Metagame
          </button>
        </p>
      </header>
      {view === 'decklists' ? (
        lists.length ? (
          <div className="comp-table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Deck</th>
                </tr>
              </thead>
              <tbody>
                {lists.map((row) => {
                  const deck = deckById(row.deck);
                  return (
                    <tr key={row.id}>
                      <td>{row.place}</td>
                      <td>
                        <Link to={`/marketplace/competitive/players/${row.playerId}`}>
                          <Flag cc={row.flag} />
                          {row.player}
                        </Link>
                      </td>
                      <td>
                        <Link to={`/marketplace/competitive/decklists/${row.id}`}>
                          {deck?.sprite ? <CardArt className="comp-sprite" src={SPRITE(deck.sprite)} alt="" fallback="hide" /> : null}
                          {deck?.name || 'Deck'}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No full lists for this event in the candyext dump. Worlds 2026 has the representative Standard lists.</p>
        )
      ) : null}
      {view === 'meta' ? (
        standings.length ? (
          <div className="comp-table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>Deck</th>
                  <th className="num">Count</th>
                  <th>Share of snapshot standings</th>
                </tr>
              </thead>
              <tbody>
                {meta.map((row) => (
                  <tr key={row.deckId}>
                    <td>
                      {row.deck ? (
                        <Link to={`/marketplace/competitive/decks/${row.deck.id}`}>
                          {row.deck.sprite ? <CardArt className="comp-sprite" src={SPRITE(row.deck.sprite)} alt="" fallback="hide" /> : null}
                          {row.deck.name}
                        </Link>
                      ) : row.deckId}
                    </td>
                    <td className="num">{row.count}</td>
                    <td>
                      <span className="comp-share">
                        {row.share.toFixed(1)}%
                        <span className="share-bar"><i style={{ width: `${Math.min(100, row.share)}%` }} /></span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">
            {event.status === 'upcoming'
              ? 'This tournament has not started yet.'
              : 'Standings for this event are not in the snapshot, so there is no event metagame here. See all decks for the format share.'}
          </p>
        )
      ) : null}
      {view === 'standings' ? (
        standings.length ? (
          <div className="comp-table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Deck</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((row) => {
                  const deck = deckById(row.deck);
                  const list = row.list ? listById(row.list) : null;
                  return (
                    <tr key={`${row.place}-${row.playerId}`}>
                      <td>{row.place}</td>
                      <td>
                        <Link to={`/marketplace/competitive/players/${row.playerId}`}>
                          <Flag cc={row.flag} />
                          {row.player}
                        </Link>
                      </td>
                      <td>
                        {list ? (
                          <Link to={`/marketplace/competitive/decklists/${row.list}`}>
                            {deck?.sprite ? <CardArt className="comp-sprite" src={SPRITE(deck.sprite)} alt="" fallback="hide" /> : null}
                            {deck?.name || 'Deck'}
                          </Link>
                        ) : (
                          <span>
                            {deck?.sprite ? <CardArt className="comp-sprite" src={SPRITE(deck.sprite)} alt="" fallback="hide" /> : null}
                            {deck?.name || '—'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">
            {event.status === 'upcoming'
              ? 'This tournament has not started yet.'
              : 'Standings for this event are not in the snapshot. The dump includes Worlds 2026 (id 515) standings and three representative lists.'}
          </p>
        )
      ) : null}
    </div>
  );
}

export default function CompetitiveTournaments() {
  const { id } = useParams();
  return id ? <TournamentDetail /> : <TournamentList />;
}
