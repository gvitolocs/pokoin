import { createEffect, createMemo, createSignal, For, Show, onSettled } from 'solid-js';
import { Portal } from '@solidjs/web';
import { cardFromCatalogRow, fetchSearch } from '@market/api.js';
import { LIST_LANGS, MOOD_CONDS } from '@market/card-desk.js';
import {
  addItem,
  closeIntent,
  commitQuantity,
  draftChanged,
  gameDisplayName,
  itemPriceLine,
  newDraft,
  newItem,
  removeItem,
  rowsShowGame,
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

/** What the price cell says for the three lines that are not an amount. */
const PRICE_TEXT = {
  pending: '—',
  later: 'Priced after saving',
  sold: 'No sold price',
};
const PRICE_TITLE = {
  amount: 'What this exact printing last sold for, as the server answered it for this saved list.',
  pending: 'The server has priced this card; the currency the desk writes amounts in is still being read.',
  later: 'The server prices a card with the list: this row is new to the list, or a facet has changed since the last answer.',
  sold: 'The server answered this list and nothing had sold on this exact printing.',
};

function searchRows(rows, gameId) {
  // No price from the search: what a result carries is what somebody asks for a
  // card, and a collection row is priced by the server and nothing else.
  return (rows || []).map((row) => ({
    cardId: String(row.id || row.card_id || ''),
    game: gameId,
    name: row.name || '',
    setName: row.setName || row.set || row.set_name || '',
    number: row.number || '',
    image: row.image || row.imageUrl || row.gridImageUrl || '',
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
  const found = createLiveSuggest(props.query, { kind: 'singles', limit: SEARCH_LIMIT });
  return (
    <SearchUi
      query={props.query}
      onQuery={props.onQuery}
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
  const [rows, setRows] = createSignal([]);
  const [busy, setBusy] = createSignal(false);

  createEffect(() => [props.query(), props.gameId], ([typed, gameId]) => {
    setRows([]);
    const name = String(typed || '').trim();
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
      query={props.query}
      onQuery={props.onQuery}
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
 *
 * `props.item` is the row's accessor: the row is keyed on its own id, so this
 * component is never re-made by an edit of its own and every focus in it
 * survives the edit.
 */
function ItemRow(props) {
  const item = () => props.item;
  const patch = (changes) => props.onPatch(item().id, changes);
  // The set line names the game only when the list holds more than one: a
  // "Base Set 4/102 · Pokémon" under every card of a Pokémon list would just
  // repeat the picker above, and the catalog id alone reads like a field name.
  const meta = createMemo(() => [
    item().setName,
    props.showGame && gameDisplayName(item().game),
  ].filter(Boolean).join(' · '));
  // What the seller is typing, until the field lets go of it. The row's quantity
  // is a committed number; an empty field is a number still being written, not a
  // quantity of none, so it stays on screen exactly as typed until blur or Enter.
  const [typed, setTyped] = createSignal(null);
  const copies = createMemo(() => typed() ?? String(item().quantity));
  function commit() {
    if (typed() === null) return;
    const value = commitQuantity(typed(), item().quantity, props.limits);
    setTyped(null);
    if (value !== item().quantity) patch({ quantity: value });
  }
  // An amount is only an amount in the currency the desk shows, and only ever
  // the server's own price for this exact slice: the module decides which of the
  // four lines the cell says, this only writes it.
  const line = createMemo(() => itemPriceLine(item(), { currencyPending: Boolean(props.currencyPending) }));
  return (
    <li class="collections-item" data-testid="collections-item">
      <div class="collections-item-identity">
        <strong>{item().name || 'Card'}</strong>
        <em>{meta()}</em>
        <span
          class={`collections-item-price${line() === 'amount' ? '' : ' is-note'}`}
          title={PRICE_TITLE[line()]}
          data-testid="collections-item-price"
        >
          {line() === 'amount' ? amount(item().pricePkn, props.currency) : PRICE_TEXT[line()]}
        </span>
      </div>
      <div class="collections-item-facets">
        <label class="collections-mini">
          <span>Copies</span>
          <input
            type="number"
            min="1"
            max={props.limits.quantity}
            value={copies()}
            onInput={(event) => setTyped(event.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              // Enter commits from the keyboard; Tab and a click commit on blur.
              event.preventDefault();
              commit();
            }}
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
 * draft of its own: leaving it sends nothing to the server, and a save that
 * comes back refused keeps both the dialog and every field in it. A saved row
 * and its copies are what the answer says they are — the server resolves every
 * price, so nothing here asks for one. The amount a row shows is the server's
 * own for that exact slice: a card added from the search, or one whose facets
 * have moved since the answer, waits to be priced by the save.
 *
 * Escape, Cancel, the cross and the scrim all go through `leave`, which asks
 * once — inline — before it throws a changed draft away. `closeIntent` decides
 * what any of them means.
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
  // The query lives here, not in the field: Escape is one handler for the whole
  // dialog, and what it means depends on whether a search is open.
  const [searchText, setSearchText] = createSignal('');
  const [asking, setAsking] = createSignal(false);
  // The typeahead ranks one name pool — the page's own game, and Pokémon only.
  // Any other game the picker offers goes to the marketplace search instead.
  const liveSearch = () => pickedGame() === (props.hostGame || game().id) && isPokemonGame();

  // The page behind a dialog that covers it must not move: the wheel over the
  // scrim scrolled the dashboard out of sight under the editor. Whatever path
  // closes this — Escape, Cancel, the scrim, a saved draft — runs the cleanup.
  onSettled(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  });

  let box;
  let nameBox;
  const dirty = createMemo(() => draftChanged(draft(), book().saved()));

  function leave(key = '') {
    switch (closeIntent({ key, search: searchText(), dirty: dirty(), asking: asking() })) {
      case 'search':
        // The query was what Escape was about; the list keeps every field.
        setSearchText('');
        break;
      case 'ask':
        setAsking(true);
        break;
      case 'stay':
        setAsking(false);
        break;
      default:
        // Closing is discarding: nothing is sent, and the table keeps what it had.
        props.onClose();
    }
  }

  const onKey = useDialogFocus(() => box, {
    onClose: () => leave('Escape'),
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
      <div class="collections-scrim" aria-hidden="true" onClick={() => leave()} />
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
          <button type="button" class="collections-close" aria-label="Close" onClick={() => leave()}>×</button>
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
                query={searchText}
                onQuery={setSearchText}
                gameId={pickedGame()}
                onPick={add}
                atCap={atCap()}
                itemLimit={limits().items}
              />
            )}
            >
              <HostCardSearch
                query={searchText}
                onQuery={setSearchText}
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
              {/* Keyed on the row, not the slice: a facet edit writes a new object
                  into the list, and a row re-made for it loses the focus in it. */}
              <For each={draft().items} keyed={(row) => row.rowId}>
                {(item) => (
                  <ItemRow
                    item={item()}
                    showGame={rowsShowGame(draft().items)}
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
          <Show
            when={asking()}
            fallback={(
              <>
                <button type="button" class="btn ghost" onClick={() => leave()} data-testid="collections-cancel">
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
              </>
            )}
          >
            <p class="collections-ask" data-testid="collections-discard-ask">Discard changes?</p>
            <span class="collections-confirm">
              <button type="button" class="btn is-danger" onClick={() => props.onClose()} data-testid="collections-discard">
                Discard
              </button>
              <button type="button" class="btn ghost" onClick={() => leave()} data-testid="collections-keep-editing">
                Keep editing
              </button>
            </span>
          </Show>
        </footer>
      </div>
    </Portal>
  );
}
