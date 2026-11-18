import { createMemo, createSignal, For, Show } from 'solid-js';
import { useParams, useSearchParams } from '@solidjs/router';
import { competitiveData, scanUrl } from '@market/competitive.js';
import CardArt from '../components/CardArt.jsx';
import CompetitiveNav, { NotInSnapshot } from '../components/CompetitiveNav.jsx';
import { EmptyDesk } from '../components/Desk.jsx';
import { gameHref } from '@market/game.js';

function CardsList() {
  const data = competitiveData();
  const [search, setSearch] = useSearchParams();
  // Follows ?q= (Back / forward), editable until the form is submitted.
  const [query, setQuery] = createSignal(() => String(search.q || ''));
  const rows = createMemo(() => {
    const q = String(search.q || '').toLowerCase();
    return data.cards.filter((card) => !q || `${card.name} ${card.set} ${card.num} ${card.type}`.toLowerCase().includes(q));
  });

  document.title = 'Competitive cards · Pokoin';

  return (
    <div class="page desk comp-page">
      <CompetitiveNav />
      <form
        class="shop-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch({ q: query().trim() || undefined });
        }}
      >
        <p class="result-count"><strong>{rows().length}</strong> cards</p>
        <input
          class="shop-search"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search snapshot cards"
          aria-label="Search competitive cards"
        />
      </form>
      <Show when={rows().length} fallback={<EmptyDesk title="No cards match" lede="Try a set code or a shorter name." />}>
        <div class="comp-card-grid">
          <For each={rows()}>
            {(card) => (
              <a class="comp-card-tile" href={gameHref(`/marketplace/competitive/cards/${card.id}`)}>
                <CardArt src={scanUrl(card.set, card.num)} alt={card.name} />
                <strong>{card.name}</strong>
                <span class="muted">{card.set} {card.num} · {card.type}</span>
              </a>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function CardDetail(props) {
  const data = competitiveData();
  const card = props.card;
  const first = String(card.name).split(' ')[0].toLowerCase();
  const used = data.decks.filter((deck) => deck.name.toLowerCase().includes(first));

  document.title = `${card.name || 'Card'} · Pokoin`;

  return (
    <div class="page desk comp-page">
      <CompetitiveNav />
      <nav class="crumbs">
        <a href={gameHref('/marketplace/competitive/cards')}>Cards</a>
        <span>/</span>
        <span>{card.name}</span>
      </nav>
      <div class="comp-card-hero">
        <CardArt src={scanUrl(card.set, card.num)} alt={card.name} />
        <div>
          <h1>{card.name}</h1>
          <p class="muted">
            {card.set} {card.num}
            {card.hp ? ` · ${card.hp} HP` : ''}
            {' · '}
            {card.type}
            {' · '}
            {card.rarity}
          </p>
          <p>
            <a href={gameHref(`/marketplace/search?q=${encodeURIComponent(card.name)}`)}>Search marketplace</a>
          </p>
          <h2>Used in archetypes</h2>
          <Show when={used.length} fallback={<p class="muted">No archetype usage in this snapshot.</p>}>
            <div class="comp-table-wrap">
              <table class="comp-table">
                <thead>
                  <tr>
                    <th>Deck</th>
                    <th>Share</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={used}>
                    {(deck) => (
                      <tr>
                        <td>
                          <a href={gameHref(`/marketplace/competitive/decks/${deck.id}`)}>{deck.name}</a>
                        </td>
                        <td>{deck.share.toFixed(2)}%</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

function Missing() {
  document.title = 'Card · Pokoin';
  return <NotInSnapshot>That card is not in the snapshot.</NotInSnapshot>;
}

/** /marketplace/competitive/cards[/:cardId]. */
export default function CompetitiveCards() {
  const params = useParams();
  const card = () => competitiveData().cards.find((row) => row.id === params.cardId) || null;
  return (
    <Show when={params.cardId} fallback={<CardsList />}>
      <Show when={card()} keyed fallback={<Missing />}>
        {(row) => <CardDetail card={row} />}
      </Show>
    </Show>
  );
}
