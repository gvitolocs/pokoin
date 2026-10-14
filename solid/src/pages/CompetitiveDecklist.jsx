import { For, Show } from 'solid-js';
import { useParams } from '@solidjs/router';
import {
  cardHrefForName,
  deckById,
  listById,
  placeSuffix,
  tournamentById,
} from '@market/competitive.js';
import CompetitiveNav, { NotInSnapshot } from '../components/CompetitiveNav.jsx';

function Column(props) {
  const count = () => (props.rows || []).reduce((sum, [qty]) => sum + Number(qty || 0), 0);
  return (
    <div class="deck-col">
      <h3>{props.title} ({count()})</h3>
      <For each={props.rows || []}>
        {([qty, name]) => (
          <div>
            <span class="qty">{qty}</span>
            {' '}
            <a href={cardHrefForName(name)}>{name}</a>
          </div>
        )}
      </For>
    </div>
  );
}

function Decklist(props) {
  const list = props.list;
  const deck = deckById(list.deck);
  const event = tournamentById(list.event);

  document.title = `${deck?.name || 'Decklist'} · Pokoin`;

  return (
    <div class="page desk comp-page">
      <CompetitiveNav />
      <nav class="crumbs">
        <a href="/marketplace/competitive/decks">Decks</a>
        <span>/</span>
        <a href={`/marketplace/competitive/decks/${list.deck}`}>{deck?.name || 'Deck'}</a>
        <span>/</span>
        <span>List {list.id}</span>
      </nav>
      <header class="comp-infobox">
        <h1>{deck?.name || 'Decklist'}</h1>
        <p class="muted">
          {list.place}{placeSuffix(list.place)}
          {' · '}
          <a href={`/marketplace/competitive/players/${list.playerId}`}>{list.player}</a>
          {' · '}
          <a href={`/marketplace/competitive/tournaments/${list.event}`}>{event?.name || list.event}</a>
        </p>
      </header>
      <div class="decklist-main">
        <Column title="Pokémon" rows={list.pokemon} />
        <Column title="Trainer" rows={list.trainer} />
        <Column title="Energy" rows={list.energy} />
      </div>
    </div>
  );
}

function Missing() {
  document.title = 'Decklist · Pokoin';
  return <NotInSnapshot>That decklist is not in the snapshot.</NotInSnapshot>;
}

/** /marketplace/competitive/decklists/:decklistId. */
export default function CompetitiveDecklist() {
  const params = useParams();
  return (
    <Show when={listById(params.decklistId)} keyed fallback={<Missing />}>
      {(list) => <Decklist list={list} />}
    </Show>
  );
}
