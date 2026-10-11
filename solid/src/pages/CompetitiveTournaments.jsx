import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import { useParams, useSearchParams } from '@solidjs/router';
import {
  ALL_FORMATS,
  ALL_REGIONS,
  ALL_TYPES,
  FORMAT,
  FORMAT_LABEL,
  REGION_LABEL,
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
} from '@market/competitive.js';
import CardArt from '../components/CardArt.jsx';
import CompetitiveNav, { Flag, NotInSnapshot, Sprite } from '../components/CompetitiveNav.jsx';
import { DeskPanel, EmptyDesk } from '../components/Desk.jsx';

const TABS = [
  { id: 'completed', label: 'Completed' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'city', label: 'City Leagues' },
  { id: 'online', label: 'Online' },
];

const VIEWS = [
  { id: 'standings', label: 'Standings' },
  { id: 'decklists', label: 'Decklists' },
  { id: 'meta', label: 'Metagame' },
];

function toggleIn(set, value) {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function TournamentTable(props) {
  return (
    <Show when={props.rows.length} fallback={<EmptyDesk title="No events" lede="Nothing in this snapshot tab." />}>
      <DeskPanel flush>
        <div class="comp-table-wrap">
          <table class="comp-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Country</th>
                <th>Name</th>
                <th> </th>
                <th class="num">Players</th>
                <Show when={props.winner}><th>Winner</th></Show>
              </tr>
            </thead>
            <tbody>
              <For each={props.rows}>
                {(event) => (
                  <tr>
                    <td>{event.date}</td>
                    <td><Flag cc={event.country} /></td>
                    <td>
                      <a href={`/marketplace/competitive/tournaments/${event.id}`}>{event.name}</a>
                    </td>
                    <td>
                      <Show when={event.format}>
                        <CardArt class="comp-format" src={FORMAT(event.format)} alt={event.format} fallback="hide" />
                      </Show>
                    </td>
                    <td class="num">{event.players || '—'}</td>
                    <Show when={props.winner}>
                      <td>
                        <Show when={event.winner} fallback="—">
                          <span class="comp-winner">
                            <Flag cc={event.winnerFlag} />
                            <Show when={event.winnerId} fallback={event.winner}>
                              <a href={`/marketplace/competitive/players/${event.winnerId}`}>{event.winner}</a>
                            </Show>
                          </span>
                        </Show>
                      </td>
                    </Show>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </DeskPanel>
    </Show>
  );
}

function FilterSet(props) {
  return (
    <fieldset>
      <legend>{props.legend}</legend>
      <For each={props.all}>
        {(value) => (
          <label>
            <input
              type="checkbox"
              checked={props.picked.has(value)}
              onChange={() => props.onPick(toggleIn(props.picked, value))}
            />
            {props.labels[value]}
          </label>
        )}
      </For>
    </fieldset>
  );
}

function TournamentList() {
  const data = competitiveData();
  const [search, setSearch] = useSearchParams();
  const tab = () => String(search.tab || 'completed');
  const [open, setOpen] = createSignal(false);
  const [types, setTypes] = createSignal(new Set(ALL_TYPES));
  const [formats, setFormats] = createSignal(new Set(ALL_FORMATS));
  const [regions, setRegions] = createSignal(new Set(ALL_REGIONS));

  document.title = 'Tournaments · Pokoin';

  const rows = createMemo(() => {
    if (tab() === 'upcoming') return upcomingTournaments();
    if (tab() === 'city') return data.cityLeagues;
    if (tab() === 'online') return [];
    return filterCompleted({ types: types(), formats: formats(), regions: regions() });
  });
  const filtered = () => types().size < ALL_TYPES.length
    || formats().size < ALL_FORMATS.length
    || regions().size < ALL_REGIONS.length;

  return (
    <div class="page desk comp-page">
      <CompetitiveNav />
      <nav class="comp-tabs" aria-label="Tournament lists">
        <For each={TABS}>
          {(row) => (
            <button
              type="button"
              class={{ on: tab() === row.id }}
              onClick={() => setSearch({ tab: row.id === 'completed' ? undefined : row.id, view: undefined })}
            >
              {row.label}
            </button>
          )}
        </For>
      </nav>
      <Show when={tab() === 'completed'}>
        <div class="comp-filter-box">
          <button class="more" type="button" style={{ margin: '0 0 0.75rem' }} onClick={() => setOpen((value) => !value)}>
            {open() ? 'Hide tournament filter' : 'Edit tournament filter'}
          </button>
          <Show
            when={open()}
            fallback={(
              <p class="muted">
                Showing {rows().length} completed events
                {filtered() ? ' (filtered from snapshot)' : ' from snapshot'}
                .
              </p>
            )}
          >
            <form
              class="comp-filter-grid"
              onSubmit={(event) => {
                event.preventDefault();
                setOpen(false);
              }}
            >
              <FilterSet legend="Type" all={ALL_TYPES} labels={TYPE_LABEL} picked={types()} onPick={setTypes} />
              <FilterSet legend="Format" all={ALL_FORMATS} labels={FORMAT_LABEL} picked={formats()} onPick={setFormats} />
              <FilterSet legend="Region" all={ALL_REGIONS} labels={REGION_LABEL} picked={regions()} onPick={setRegions} />
              <button class="more" type="submit" style={{ margin: 0 }}>Apply selection</button>
            </form>
          </Show>
        </div>
      </Show>
      <Show when={tab() !== 'online'} fallback={<p class="muted">No online events in this snapshot.</p>}>
        <TournamentTable rows={rows()} winner={tab() !== 'upcoming'} />
      </Show>
    </div>
  );
}

function PlayerCell(props) {
  return (
    <a href={`/marketplace/competitive/players/${props.row.playerId}`}>
      <Flag cc={props.row.flag} />
      {props.row.player}
    </a>
  );
}

function TournamentDetail(props) {
  const event = props.event;
  const [search, setSearch] = useSearchParams();
  const standings = standingsFor(event.id);
  const lists = listsForEvent(event.id);
  const meta = metaFromStandings(standings);
  const data = competitiveData();
  const view = () => String(search.view || 'standings');
  const notStarted = event.status === 'upcoming';

  document.title = `${event.name || 'Tournament'} · Pokoin`;

  return (
    <div class="page desk comp-page">
      <CompetitiveNav />
      <nav class="crumbs">
        <a href="/marketplace/competitive/tournaments">Tournaments</a>
        <span>/</span>
        <span>{event.name}</span>
      </nav>
      <header class="comp-infobox">
        <h1>
          <Flag cc={event.country} />
          {event.name}
        </h1>
        <p class="muted">
          {event.date}
          {event.players ? ` · ${event.players} players` : ' · Upcoming'}
          {event.type ? ` · ${TYPE_LABEL[event.type] || event.type}` : ''}
          {event.format ? ` · ${FORMAT_LABEL[event.format] || event.format}` : ''}
          {event.region ? ` · ${REGION_LABEL[event.region] || event.region}` : ''}
          {' · '}
          {data.formatLabel}
        </p>
        <p class="comp-subnav">
          <For each={VIEWS}>
            {(row) => (
              <button
                type="button"
                class={{ on: view() === row.id }}
                onClick={() => setSearch({ view: row.id === 'standings' ? undefined : row.id, tab: undefined })}
              >
                {row.label}
              </button>
            )}
          </For>
        </p>
      </header>
      <Switch>
        <Match when={view() === 'decklists'}>
          <Show
            when={lists.length}
            fallback={<p class="muted">No full lists for this event in the snapshot. Worlds 2026 has the representative Standard lists.</p>}
          >
            <div class="comp-table-wrap">
              <table class="comp-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Player</th>
                    <th>Deck</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={lists}>
                    {(row) => {
                      const deck = deckById(row.deck);
                      return (
                        <tr>
                          <td>{row.place}</td>
                          <td><PlayerCell row={row} /></td>
                          <td>
                            <a href={`/marketplace/competitive/decklists/${row.id}`}>
                              <Sprite deck={deck} />
                              {deck?.name || 'Deck'}
                            </a>
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Match>
        <Match when={view() === 'meta'}>
          <Show
            when={standings.length}
            fallback={(
              <p class="muted">
                {notStarted
                  ? 'This tournament has not started yet.'
                  : 'Standings for this event are not in the snapshot, so there is no event metagame here. See all decks for the format share.'}
              </p>
            )}
          >
            <div class="comp-table-wrap">
              <table class="comp-table">
                <thead>
                  <tr>
                    <th>Deck</th>
                    <th class="num">Count</th>
                    <th>Share of snapshot standings</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={meta}>
                    {(row) => (
                      <tr>
                        <td>
                          <Show when={row.deck} fallback={row.deckId}>
                            <a href={`/marketplace/competitive/decks/${row.deck.id}`}>
                              <Sprite deck={row.deck} />
                              {row.deck.name}
                            </a>
                          </Show>
                        </td>
                        <td class="num">{row.count}</td>
                        <td>
                          <span class="comp-share">
                            {row.share.toFixed(1)}%
                            <span class="share-bar"><i style={{ width: `${Math.min(100, row.share)}%` }} /></span>
                          </span>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Match>
        <Match when={view() === 'standings'}>
          <Show
            when={standings.length}
            fallback={(
              <p class="muted">
                {notStarted
                  ? 'This tournament has not started yet.'
                  : 'Standings for this event are not in the snapshot. The dump includes Worlds 2026 (id 515) standings and three representative lists.'}
              </p>
            )}
          >
            <div class="comp-table-wrap">
              <table class="comp-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Player</th>
                    <th>Deck</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={standings}>
                    {(row) => {
                      const deck = deckById(row.deck);
                      return (
                        <tr>
                          <td>{row.place}</td>
                          <td><PlayerCell row={row} /></td>
                          <td>
                            <Show
                              when={row.list && listById(row.list)}
                              fallback={<span><Sprite deck={deck} />{deck?.name || '—'}</span>}
                            >
                              <a href={`/marketplace/competitive/decklists/${row.list}`}>
                                <Sprite deck={deck} />
                                {deck?.name || 'Deck'}
                              </a>
                            </Show>
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Match>
      </Switch>
    </div>
  );
}

function Missing() {
  document.title = 'Tournament · Pokoin';
  return <NotInSnapshot>That tournament is not in the snapshot.</NotInSnapshot>;
}

/** /marketplace/competitive/tournaments[/:id]. */
export default function CompetitiveTournaments() {
  const params = useParams();
  return (
    <Show when={params.id} fallback={<TournamentList />}>
      <Show when={tournamentById(params.id)} keyed fallback={<Missing />}>
        {(event) => <TournamentDetail event={event} />}
      </Show>
    </Show>
  );
}
