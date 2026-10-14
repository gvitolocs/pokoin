import { For, Show } from 'solid-js';
import {
  FORMAT,
  competitiveData,
  completedTournaments,
  listById,
  scanUrl,
  upcomingTournaments,
} from '@market/competitive.js';
import CardArt from '../components/CardArt.jsx';
import CompetitiveNav from '../components/CompetitiveNav.jsx';
import { DeskPanel } from '../components/Desk.jsx';

function EventRow(props) {
  return (
    <a class="event-row" href={`/marketplace/competitive/tournaments/${props.event.id}`}>
      <span>
        <strong>{props.event.name}</strong>
        <small>
          {props.event.date}
          {props.event.players ? ` · ${props.event.players} players` : ''}
        </small>
      </span>
      <Show when={props.event.format}>
        <CardArt class="comp-badge" src={FORMAT(props.event.format)} alt="" fallback="hide" />
      </Show>
    </a>
  );
}

function EventPanel(props) {
  return (
    <DeskPanel flush title={props.title} extra={<a class="see-all" href={props.href}>{props.more}</a>}>
      <div class="event-list">
        <For each={props.events}>{(event) => <EventRow event={event} />}</For>
      </div>
    </DeskPanel>
  );
}

/** /marketplace/competitive: the snapshot overview. */
export default function Competitive() {
  const data = competitiveData();
  const featured = data.decks.filter((deck) => deck.featured).slice(0, 6);

  document.title = 'Competitive · Pokoin';

  return (
    <div class="page desk comp-page">
      <CompetitiveNav />
      <section>
        <div class="carousel-head">
          <h2>Top decks ({data.format})</h2>
          <a class="see-all" href="/marketplace/competitive/decks">All decks</a>
        </div>
        <div class="comp-leaders">
          <For each={featured}>
            {(deck, index) => {
              const label = `Featured · ${deck.featured.place} ${deck.featured.event} — ${deck.featured.player}`;
              return (
                <article class="comp-leader">
                  <a href={`/marketplace/competitive/decks/${deck.id}`}>
                    <CardArt src={scanUrl(deck.set, deck.num)} alt={deck.name} />
                    <strong>{index() + 1}. {deck.short}</strong>
                    <em>{deck.share.toFixed(2)}%</em>
                  </a>
                  <Show when={listById(deck.featured.list)} fallback={<span class="comp-feat">{label}</span>}>
                    <a class="comp-feat" href={`/marketplace/competitive/decklists/${deck.featured.list}`}>{label}</a>
                  </Show>
                </article>
              );
            }}
          </For>
        </div>
      </section>
      <div class="comp-split">
        <EventPanel
          title="Recent tournaments"
          more="All completed"
          href="/marketplace/competitive/tournaments"
          events={completedTournaments().slice(0, 6)}
        />
        <div>
          <EventPanel
            title="Upcoming"
            more="All upcoming"
            href="/marketplace/competitive/tournaments?tab=upcoming"
            events={upcomingTournaments()}
          />
          <EventPanel
            title="City leagues"
            more="All leagues"
            href="/marketplace/competitive/tournaments?tab=city"
            events={data.cityLeagues}
          />
        </div>
      </div>
    </div>
  );
}
