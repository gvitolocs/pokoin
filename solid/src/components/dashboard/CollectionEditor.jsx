import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { Portal } from '@solidjs/web';
import { cardFromCatalogRow, fetchSearch } from '@market/api.js';
import { LIST_LANGS, MOOD_CONDS } from '@market/card-desk.js';
import {
  addItem,
  newDraft,
  newItem,
  removeItem,
  setItem,
} from '@market/portfolio-collections.js';
import { GAMES, game, isPokemonGame } from '@market/game.js';
import { assetsAmountLabel as amount } from '@market/seller-currency.js';
import { createLiveSuggest } from '../../lib/live-suggest.js';
import { useDialogFocus } from '../../lib/dialog-focus.js';
import '@market/seller-collections.css';

/** The games the picker offers, by display name. */
const GAME_CHOICES = Object.values(GAMES)
  .map((row) => ({ id: row.id, name: row.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

const SEARCH_LIMIT = 12;
/** Two hundred ms: the seller is typing a name, not running a query. */
const SEARCH_DEBOUNCE = 200;

function searchRows(rows, gameId) {
  return (rows || []).map((row) => ({
    cardId: String(row.id || row.card_id || ''),
    game: gameId,
    name: row.name || '',
    setName: row.setName || row.set || row.set_name || '',
    number: row.number || '',
    image: row.image || row.imageUrl || row.gridImageUrl || '',
    pricePkn: row.pricePkn ?? row.price ?? null,
  })).filter((row) => /^\d+$/.test(row.cardId));
}

/**
 * The search field and the rows it offers, in the one markup both sources use.
 * A result without a public card id is dropped here rather than sent: the
 * collection prices a printing by that id and nothing else answers for it.
 */
function SearchUi(props) {
  function choose(row) {
    if (props.atCap) return;
    props.onPick(row);
  }
  function onKeydown(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    // Enter takes the top row: the seller typed the name they were looking for.
    const top = (props.rows || [])[0];
    if (top) choose(top);
  }
  return (
    <div class="collections-search">
      <label class="collections-field">
        <span>Find a card</span>
        <input
          type="search"
          value={props.query()}
          placeholder={props.placeholder}
          disabled={props.atCap}
          onInput={(event) => props.onQuery(event.currentTarget.value)}
          onKeyDown={onKeydown}
          data-testid="collections-search-input"
        />
      </label>
      <Show when={props.atCap}>
        <p class="collections-cap">
          {`This collection holds up to ${props.itemLimit} cards. Save it and make another list for the rest.`}
        </p>
      </Show>
      <Show when={props.rows?.length}>
        <ul class="collections-results" data-testid="collections-results">
          <For each={props.rows}>
            {(row) => (
              <li>
                <button type="button" data-testid="collections-result" onClick={() => choose(row)}>
                  <Show when={row.image}>
                    <img src={row.image} alt="" width="40" height="56" loading="lazy" />
                  </Show>
                  <span class="collections-result-name">
                    <strong>{row.name}</strong>
                    <em>{[row.setName, row.number].filter(Boolean).join(' · ')}</em>
                  </span>
                  <span class="collections-result-add">Add</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

/** The header game's own typeahead: the same engine and ranker as the search bar. */
function HostCardSearch(props) {
  const [query, setQuery] = createSignal('');
  const found = createLiveSuggest(query, { kind: 'singles', limit: SEARCH_LIMIT });
  return (
    <SearchUi
      query={query}
      onQuery={setQuery}
      rows={searchRows(found(), props.gameId)}
      placeholder="Pokémon card name, set or number"
      onPick={props.onPick}
      atCap={props.atCap}
      itemLimit={props.itemLimit}
    />
  );
}

/**
 * Any other catalog: the marketplace search page, asked for cards of that game.
 * The header typeahead ranks one name pool — the page's own game — and says
 * nothing about another, so this path is the search the results page uses.
 */
function CatalogCardSearch(props) {
  const [query, setQuery] = createSignal('');
  const [rows, setRows] = createSignal([]);
  const [busy, setBusy] = createSignal(false);

  createEffect(() => [query(), props.gameId], ([text, gameId]) => {
    setRows([]);
    const name = String(text || '').trim();
    if (name.length < 2) {
      setBusy(false);
      return undefined;
    }
    const controller = new AbortController();
    setBusy(true);
    let live = true;
    const timer = setTimeout(() => {
      fetchSearch({ query: name, limit: SEARCH_LIMIT, productType: 'card', game: gameId, signal: controller.signal })
        .then((data) => {
          if (!live) return;
          setRows(searchRows((data?.cards || []).map(cardFromCatalogRow), gameId));
        })
        .catch(() => { if (live) setRows([]); })
        .finally(() => { if (live) setBusy(false); });
    }, SEARCH_DEBOUNCE);
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  });

  return (
    <SearchUi
      query={query}
      onQuery={setQuery}
      rows={busy() ? [] : rows()}
      placeholder="Card name in this game"
      onPick={props.onPick}
      atCap={props.atCap}
      itemLimit={props.itemLimit}
    />
  );
}

/**
 * One card in the draft: what it is, and the five facets and copies the server
 * prices it by. The vocabulary is the listing forms' own — `MOOD_CONDS` and
 * `LIST_LANGS` — because a collection row means the same thing as a listing.
 */
function ItemRow(props) {
  const item = () => props.item;
  const patch = (changes) => props.onPatch(item().id, changes);
  // An amount is only an amount in the currency the desk shows. While that read
  // is out the cell keeps its shape with a dash and guesses no unit at all.
  const price = () => {
    if (props.currencyPending) return '—';
    return Number(item().pricePkn) > 0 ? amount(item().pricePkn, props.currency) : 'No sold price';
  };
  return (
    <li class="collections-item" data-testid="collections-item">
      <div class="collections-item-identity">
        <strong>{item().name || 'Card'}</strong>
        <em>{[item().setName, item().game].filter(Boolean).join(' · ')}</em>
        <span class="collections-item-price" title="What this printing is worth today: the last sold price the server answers with, or the price the search showed when it was added. Neither says No sold price.">
          {price()}
        </span>
      </div>
      <div class="collections-item-facets">
        <label class="collections-mini">
          <span>Copies</span>
          <input
            type="number"
            min="1"
            max={props.limits.quantity}
            value={item().quantity}
            onInput={(event) => patch({ quantity: Number(event.currentTarget.value) })}
            aria-label={`Copies of ${item().name || 'card'}`}
            data-testid="collections-item-quantity"
          />
        </label>
        <label class="collections-mini">
          <span>Condition</span>
          <select value={item().condition} onChange={(event) => patch({ condition: event.currentTarget.value })} aria-label={`Condition of ${item().name || 'card'}`}>
            <For each={MOOD_CONDS}>{(cond) => <option value={cond.value}>{cond.label}</option>}</For>
          </select>
        </label>
        <label class="collections-mini">
          <span>Language</span>
          <select value={item().language} onChange={(event) => patch({ language: event.currentTarget.value })} aria-label={`Language of ${item().name || 'card'}`}>
            <For each={LIST_LANGS}>{(code) => <option value={code}>{code}</option>}</For>
          </select>
        </label>
        <label class="collections-flag">
          <input type="checkbox" checked={item().reverse} onChange={(event) => patch({ reverse: event.currentTarget.checked })} />
          <span>Reverse</span>
        </label>
        <label class="collections-flag">
          <input type="checkbox" checked={item().firstEdition} onChange={(event) => patch({ firstEdition: event.currentTarget.checked })} />
          <span>1st edition</span>
        </label>
        <label class="collections-flag">
          <input type="checkbox" checked={item().graded} onChange={(event) => patch({ graded: event.currentTarget.checked })} />
          <span>Graded</span>
        </label>
        <button
          type="button"
          class="collections-item-remove"
          aria-label={`Remove ${item().name || 'card'} from this collection`}
          onClick={() => props.onRemove(item().id)}
          data-testid="collections-item-remove"
        >
          Remove
        </button>
      </div>
    </li>
  );
}

/**
 * The collection editor: name it, find the cards, set the facets, save.
 *
 * Opened from a Collections row (Edit) or the New collection button, it holds a
 * draft of its own: Cancel and Escape throw it away without asking the server
 * anything, and a save that comes back refused keeps both the dialog and every
 * field in it. A saved row and its copies are what the answer says they are —
 * the server resolves every price, so nothing here asks for one.
 *
 * The card search is the header typeahead when the seller is in the page's own
 * game (`createLiveSuggest`, one ranker for one name pool) and the marketplace
 * search page for any other game the picker offers.
 */
export default function CollectionEditor(props) {
  const book = () => props.book;
  const limits = createMemo(() => book().limits());
  const [draft, setDraft] = createSignal(newDraft(book().saved()));
  const [serverProblem, setServerProblem] = createSignal('');
  const [pickedGame, setPickedGame] = createSignal(props.hostGame || game().id);
  // The typeahead ranks one name pool — the page's own game, and Pokémon only.
  // Any other game the picker offers goes to the marketplace search instead.
  const liveSearch = () => pickedGame() === (props.hostGame || game().id) && isPokemonGame();

  let box;
  let nameBox;
  const onKey = useDialogFocus(() => box, {
    // Closing is discarding: nothing is sent, and the table keeps what it had.
    onClose: () => props.onClose(),
    first: () => nameBox,
  });

  const atCap = createMemo(() => draft().items.length >= limits().items);
  // The store is the one that knows a write is in flight: the button follows
  // it, so a double press cannot queue two saves.
  const saving = createMemo(() => Boolean(book().saving()));
  // The taken-name check reads the saved lists: touch them, or a save that
  // changed them while this dialog was open would be validated stale.
  const problems = createMemo(() => {
    book().collections();
    return book().validate(draft());
  });
  const reason = createMemo(() => problems()[0] || '');
  const copies = createMemo(() => draft().items.reduce((acc, item) => acc + (Number(item.quantity) || 0), 0));

  function edit(next) {
    setServerProblem('');
    setDraft(next);
  }

  function add(card) {
    const before = draft();
    // The collector number goes into the set name: two Charizard printings with
    // the same set label are otherwise indistinguishable in this list, and the
    // item shape the server answers with has no number of its own.
    const row = newItem({
      ...card,
      game: card.game || pickedGame(),
      setName: [card.setName, card.number].filter(Boolean).join(' '),
    }, limits());
    if (!row) return;
    const next = addItem(before, row, limits());
    edit(next);
    // The list grew, or this row was already in it, or the cap refused the add:
    // only the third case has to say something, because the field just did
    // nothing at all.
    const merged = before.items.some((entry) => entry.id === row.id);
    if (next.items.length === before.items.length && !merged) {
      setServerProblem(`A collection holds up to ${limits().items} cards.`);
    }
  }

  async function save() {
    if (saving() || problems().length) return;
    const answer = await book().save(draft());
    // A saved dialog is gone with its draft; a refused one stays with both.
    if (answer?.ok) return;
    setServerProblem(answer?.message || 'Could not save the collection.');
  }

  const title = () => (draft().id ? 'Edit collection' : 'New collection');

  return (
    <Portal mount={document.body}>
      <div class="collections-scrim" aria-hidden="true" onClick={() => props.onClose()} />
      <div
        class="collections-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collections-editor-title"
        onKeyDown={onKey}
        ref={(el) => { box = el; }}
        data-testid="collections-editor"
      >
        <header class="collections-head">
          <h3 id="collections-editor-title" class="thread-title">{title()}</h3>
          <button type="button" class="collections-close" aria-label="Close" onClick={() => props.onClose()}>×</button>
        </header>

        <div class="collections-body">
          <label class="collections-field">
            <span>Name</span>
            <input
              ref={(el) => { nameBox = el; }}
              type="text"
              value={draft().name}
              maxLength={limits().name}
              placeholder="Charizard binder"
              onInput={(event) => edit({ ...draft(), name: event.currentTarget.value })}
              data-testid="collections-name"
            />
            <em class="collections-count">{`${draft().name.length} / ${limits().name}`}</em>
          </label>

          <div class="collections-add">
            <label class="collections-field">
              <span>Game</span>
              <select
                value={pickedGame()}
                onChange={(event) => setPickedGame(event.currentTarget.value)}
                data-testid="collections-game"
              >
                <For each={GAME_CHOICES}>{(row) => <option value={row.id}>{row.name}</option>}</For>
              </select>
            </label>
            <Show when={liveSearch()} fallback={(
              <CatalogCardSearch
                gameId={pickedGame()}
                onPick={add}
                atCap={atCap()}
                itemLimit={limits().items}
              />
            )}
            >
              <HostCardSearch
                gameId={pickedGame()}
                onPick={add}
                atCap={atCap()}
                itemLimit={limits().items}
              />
            </Show>
          </div>

          <p class="collections-tally" data-testid="collections-tally">
            <span>{`${draft().items.length} of ${limits().items} cards`}</span>
            <em>{copies() === draft().items.length ? '' : `${copies()} copies`}</em>
          </p>

          <Show when={draft().items.length}>
            <ul class="collections-items" data-testid="collections-items">
              <For each={draft().items}>
                {(item) => (
                  <ItemRow
                    item={item}
                    limits={limits()}
                    currency={props.currency}
                    currencyPending={Boolean(props.currencyPending)}
                    onPatch={(id, changes) => edit(setItem(draft(), id, changes, limits()))}
                    onRemove={(id) => edit(removeItem(draft(), id))}
                  />
                )}
              </For>
            </ul>
          </Show>

          <Show when={serverProblem() || reason()}>
            <p class={['collections-problem', { 'is-server': Boolean(serverProblem()) }]} data-testid="collections-problem">
              {serverProblem() || reason()}
            </p>
          </Show>
        </div>

        <footer class="collections-foot">
          <button type="button" class="btn ghost" onClick={() => props.onClose()} data-testid="collections-cancel">
            Cancel
          </button>
          <button
            type="button"
            class="btn"
            disabled={saving() || Boolean(problems().length)}
            title={reason()}
            onClick={save}
            data-testid="collections-save"
          >
            {saving() ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </Portal>
  );
}
