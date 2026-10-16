import { createEffect, createMemo, createSignal, For, onSettled, Repeat, Show, untrack } from 'solid-js';
import { useParams, useSearchParams } from '@solidjs/router';
import { useGameNavigate } from '../lib/game-navigate.js';
import { fetchSellerShop, fetchSellerSnapshot } from '@market/api.js';
import { associateRoleLabel } from '@market/associate-roles.js';
import { cartItemFromOffer } from '@market/cart-rows.js';
import { game } from '@market/game.js';
import { publicListingSellerName, sellerCountryFlag, sellerCountryShort, sellerHandle } from '@market/listing-meta.js';
import { getSearchLang } from '@market/locale.js';
import { rememberSellerIdentity, seedSellerListings, sellerIdentitySeed } from '@market/seller-seed.js';
import { filterSellerBook } from '@market/seller-shop-filter.js';
import { listingSelectId, shopDragOffers } from '@market/shop-marquee.js';
import {
  SELLER_CONDITION_FILTERS,
  SELLER_FRESH_FIRST_MS,
  SELLER_FRESH_RETRY_MS,
  SELLER_LANG_FILTERS,
  SELLER_PAGE_SIZE as PAGE_SIZE,
  SELLER_RARITY_FILTERS,
  isOneDayReady,
  sellerFiltersNarrow,
  sellerFreshAction,
  sellerFromPayload,
  sellerOfferRow,
} from '@market/seller-shop.js';
import Avatar from '../components/Avatar.jsx';
import { Alert, EmptyDesk, Metric, MetricGrid } from '../components/Desk.jsx';
import ShopListingRow, { ShopList } from '../components/desk/ShopListing.jsx';
import { listingSelected } from '../lib/select-band.js';
import { accountProfile } from '../stores/account.js';
import { authUser, signedIn } from '../stores/auth.js';
import { addCartItem } from '../stores/cart.js';
import { authSession } from '../stores/session.js';

// A tab that comes back after this long asks fresh=1 whether the shop moved.
const BOOK_REVISIT_MS = 60_000;

const isBook = (data) => Boolean(data?.book && Array.isArray(data.listings));

function ShopToggle(props) {
  return (
    <button
      type="button"
      class={['shop-toggle', { on: props.pressed }]}
      aria-pressed={props.pressed ? 'true' : 'false'}
      onClick={() => props.onToggle(!props.pressed)}
    >
      {props.label}
    </button>
  );
}

function SkeletonRows() {
  return (
    <div class="shop-list seller-shop-list" aria-busy="true" aria-label="Loading listings">
      <Repeat count={8}>
        {() => (
          <div class="shop-row is-profile shop-row-skel" aria-hidden="true">
            <span class="shop-card">
              <span class="shop-art shop-skel-art" />
              <span class="shop-skel-copy">
                <span class="skeleton-line" />
                <span class="skeleton-line short" />
              </span>
            </span>
            <span class="shop-facets">
              <span class="skeleton-line shop-skel-facet" />
              <span class="skeleton-line shop-skel-price" />
            </span>
          </div>
        )}
      </Repeat>
    </div>
  );
}

/**
 * Public seller shop: one request. The shop snapshot (the stored book, c1v2 +
 * brotli 11, edge-cached; local-first, so a revisit paints from the store)
 * paints the shop and every filter / sort / page runs locally on it. Without a
 * snapshot the live book route (`book=1`) answers, and server pages are the
 * fallback when neither does. After painting, and when a tab comes back after
 * a minute, `fresh=1` compares the shop's stamp with the book's: only a moved
 * shop reads its book again.
 * Not ported yet: the rubber-band multi-select of shop rows (rows drag
 * themselves).
 */
function SellerShop(props) {
  const handle = untrack(() => props.handle);
  const [searchParams] = useSearchParams();
  const navigate = useGameNavigate();
  const lang = () => props.lang || getSearchLang();
  const hintedUid = () => String(searchParams.sellerUid || '').trim();
  const selectedGame = game().apiGame;
  const seeded = seedSellerListings(handle, { pageSize: PAGE_SIZE, sort: 'price-desc', game: selectedGame });
  const known = sellerIdentitySeed(handle);

  const [listings, setListings] = createSignal(seeded?.listings ?? null);
  const [total, setTotal] = createSignal(seeded?.total ?? null);
  const [unique, setUnique] = createSignal(seeded?.unique ?? null);
  const [copies, setCopies] = createSignal(seeded?.copies ?? null);
  const [seller, setSeller] = createSignal(seeded?.seller ?? known ?? {
    uid: untrack(hintedUid),
    username: handle,
    displayName: handle,
  });
  const [error, setError] = createSignal('');
  const [query, setQuery] = createSignal('');
  const [condition, setCondition] = createSignal('');
  const [language, setLanguage] = createSignal('');
  const [rarity, setRarity] = createSignal('');
  const [reverse, setReverse] = createSignal(false);
  const [firstEdition, setFirstEdition] = createSignal(false);
  const [sort, setSort] = createSignal('price-desc');
  // Back to page 1 whenever a filter changes (a writable memo; the pager writes it).
  const [page, setPage] = createSignal(() => {
    query(); condition(); language(); rarity(); reverse(); firstEdition(); sort();
    return 1;
  });
  const [loading, setLoading] = createSignal(!seeded);
  const [book, setBook] = createSignal(null);
  // The book is asked for on mount, so pages wait for it from the first run.
  const [bookPhase, setBookPhase] = createSignal('loading');
  const [pageSettled, setPageSettled] = createSignal(Boolean(seeded));
  // Plain mirrors (React refs): read by requests that start before a flush.
  let sellerUidNow = untrack(hintedUid) || seeded?.seller?.uid || known?.uid || '';
  let listingsNow = seeded?.listings ?? null;

  function putSeller(update) {
    setSeller((current) => {
      const next = update(current);
      if (next.uid) sellerUidNow = next.uid;
      return next;
    });
  }

  function putListings(rows) {
    listingsNow = rows;
    setListings(() => rows);
  }

  const filters = () => ({
    query: query(),
    condition: condition(),
    language: language(),
    rarity: rarity(),
    reverse: reverse(),
    firstEdition: firstEdition(),
    sort: sort(),
  });

  createEffect(hintedUid, (uid) => {
    if (!uid) return;
    sellerUidNow = uid;
    rememberSellerIdentity(handle, { uid, username: handle });
    setSeller((current) => (current.uid ? current : { ...current, uid }));
  });

  createEffect(
    () => seller().displayName,
    (name) => {
      document.title = `${name || handle} · Pokoin`;
    },
  );

  // Where the book came from: the snapshot, or the live book route.
  let bookSource = 'snapshot';
  let disposed = false;
  function adopt(data) {
    if (disposed) return;
    setBook(() => data);
    setBookPhase('ready');
    putSeller((current) => sellerFromPayload(data, handle, data.listings[0], current));
  }

  // The whole book on mount: the snapshot (a stored copy paints at once and
  // the network copy replaces it when it differs), else the live book route.
  createEffect(() => true, () => {
    let cancelled = false;
    setBook(null);
    setBookPhase('loading');
    fetchSellerSnapshot(handle, { onUpdate: (data) => !cancelled && isBook(data) && adopt(data) })
      .then((data) => {
        if (cancelled) return null;
        if (isBook(data)) {
          adopt(data);
          checkFresh(SELLER_FRESH_FIRST_MS);
          return null;
        }
        bookSource = 'live';
        return fetchSellerShop(handle, { book: true, game: selectedGame, sellerUid: sellerUidNow });
      })
      .then((data) => {
        if (cancelled || data === null) return;
        if (!isBook(data)) {
          setBookPhase('server');
          return;
        }
        adopt(data);
        checkFresh(SELLER_FRESH_FIRST_MS);
      })
      .catch(() => {
        if (!cancelled) setBookPhase('server');
      });
    return () => {
      cancelled = true;
    };
  });

  // Freshness: one cheap stamp read (fresh=1, edge-cached seconds). A moved
  // shop reads the newer stored book by its version, or waits while it is
  // built; an unchanged shop costs nothing more.
  let freshTimer = 0;
  let freshTries = 0;
  function checkFresh(delay) {
    clearTimeout(freshTimer);
    freshTimer = setTimeout(() => {
      const current = untrack(book);
      if (disposed || !current || document.visibilityState === 'hidden') return;
      fetchSellerShop(handle, { fresh: true, sellerUid: current.seller?.uid || sellerUidNow, game: selectedGame })
        .then((fresh) => {
          const action = sellerFreshAction(current, fresh);
          if (action === 'current') {
            freshTries = 0;
            return;
          }
          const next = bookSource === 'live'
            ? fetchSellerShop(handle, { book: true, game: selectedGame, sellerUid: sellerUidNow })
            : action === 'refetch' ? fetchSellerSnapshot(handle, { version: fresh.book.version }) : Promise.resolve(null);
          return next.then((data) => {
            if (isBook(data) && String(data.maxUpdatedAt || '') !== String(current.maxUpdatedAt || '')) adopt(data);
            const behind = sellerFreshAction(untrack(book), fresh) !== 'current';
            if (behind && freshTries < SELLER_FRESH_RETRY_MS.length) checkFresh(SELLER_FRESH_RETRY_MS[freshTries++]);
          });
        })
        .catch(() => {});
    }, delay);
  }

  // Revisit: a tab hidden for a minute asks fresh=1 when it comes back.
  onSettled(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      if (!untrack(book) || !hiddenAt || Date.now() - hiddenAt < BOOK_REVISIT_MS) return;
      hiddenAt = 0;
      freshTries = 0;
      checkFresh(0);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      clearTimeout(freshTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });

  // Server pages only when the book is unavailable: while it downloads the
  // page shows the listings cache or the skeleton, not a second (slow) query.
  createEffect(
    () => ({ book: book(), bookPhase: bookPhase(), page: page(), ...filters() }),
    (input) => {
      const narrow = sellerFiltersNarrow(input);
      if (input.book || input.bookPhase === 'loading') {
        setPageSettled(true);
        return undefined;
      }
      let cancelled = false;
      const warm = !narrow && listingsNow != null;
      if (!warm) setLoading(true);
      const offset = (Math.max(1, input.page) - 1) * PAGE_SIZE;
      fetchSellerShop(handle, {
        limit: PAGE_SIZE,
        offset,
        q: input.query.trim(),
        condition: input.condition,
        language: input.language,
        rarity: input.rarity,
        reverse: input.reverse,
        firstEdition: input.firstEdition,
        sort: input.sort,
        game: selectedGame,
        sellerUid: sellerUidNow,
      })
        .then((data) => {
          if (cancelled) return;
          const rows = data.listings || data.items || [];
          putListings(rows);
          putSeller((current) => sellerFromPayload(data, handle, rows[0], current));
          setTotal(Number(data.total ?? rows.length) || 0);
          setUnique(Number(data.unique ?? data.uniqueCards ?? rows.length) || 0);
          setCopies(data.copies == null ? null : (Number(data.copies) || 0));
          setError('');
          setLoading(false);
          setPageSettled(true);
        })
        .catch((err) => {
          if (cancelled) return;
          setPageSettled(true);
          if (warm) {
            setLoading(false);
            return;
          }
          putListings([]);
          setTotal(0);
          setUnique(0);
          setCopies(0);
          setError(err.message || 'Seller not found.');
          setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    },
  );

  const filtersNarrow = () => sellerFiltersNarrow({ ...filters(), page: page() });
  const bookView = createMemo(() => {
    const data = book();
    if (!data?.listings) return null;
    const input = filters();
    return filterSellerBook(data.listings, { ...input, q: input.query.trim() });
  });
  const shownOffset = () => (Math.max(1, page()) - 1) * PAGE_SIZE;
  const shown = createMemo(() => (bookView()
    ? bookView().rows.slice(shownOffset(), shownOffset() + PAGE_SIZE)
    : listings()));
  const productCount = () => (bookView() ? bookView().rows.length : total()) ?? 0;
  const uniqueItems = () => (bookView() ? bookView().unique : unique()) ?? 0;
  const copyCount = () => (bookView() ? bookView().copies : copies());
  const busy = () => (bookView() ? false : (loading() || (bookPhase() === 'loading' && filtersNarrow())));

  const sample = () => shown()?.[0];
  const display = () => seller().displayName || publicListingSellerName(sample(), handle);
  const tag = () => seller().username || sellerHandle(sample()) || handle;
  const showTag = () => tag() && tag().toLowerCase() !== String(display() || '').toLowerCase();
  const country = () => sellerCountryFlag(seller().country || sample()?.sellerCountry);
  const countryShort = () => sellerCountryShort(seller().country || sample()?.sellerCountry);
  const ready = () => Boolean((shown() || []).some(isOneDayReady));
  const totalPages = () => Math.max(1, Math.ceil(productCount() / PAGE_SIZE) || 1);
  const safePage = () => Math.min(Math.max(1, page()), totalPages());
  const startIdx = () => (productCount() ? (safePage() - 1) * PAGE_SIZE + 1 : 0);
  const endIdx = () => Math.min(safePage() * PAGE_SIZE, productCount());
  const notFound = () => shown() && !shown().length && error() && productCount() === 0 && !busy();

  // Your own shop is managed in MyPokoin, not bought from.
  const isOwnShop = () => {
    const own = String(accountProfile()?.username || '').trim().toLowerCase();
    const uid = signedIn() ? String(authUser()?.uid || authSession()?.uid || '') : '';
    return Boolean(
      (own && own === handle.replace(/^@/, '').toLowerCase())
      || (uid && seller().uid && seller().uid === uid),
    );
  };
  createEffect(
    () => !notFound() && isOwnShop(),
    (own) => {
      if (own) navigate('/mypokoin', { replace: true });
    },
  );

  const rows = createMemo(() => (shown() || []).map((offer, index) => ({ offer, index, ...sellerOfferRow(offer, lang()) })));
  const shownOffers = createMemo(() => rows().map((row) => row.enriched));

  return (
    <Show
      when={!notFound()}
      fallback={(
        <EmptyDesk title="Seller not found" lede={error()}>
          <p class="status">Usernames match live native listings.</p>
        </EmptyDesk>
      )}
    >
      <Show when={!isOwnShop()}>
        <div class="page desk seller-page seller-shop-ct">
          <header class="seller-hero seller-hero-ct">
            <Show
              when={seller().photoUrl}
              fallback={(
                <span class="seller-avatar" aria-hidden="true">
                  {(display() || '?').slice(0, 1).toUpperCase()}
                </span>
              )}
            >
              <Avatar class="seller-avatar" src={seller().photoUrl} seed={seller().uid} name={display()} size={88} />
            </Show>
            <div class="seller-id">
              <p class="page-kicker">Seller</p>
              <h1 class="page-title">
                {display()}
                <Show when={seller().associate?.role}>
                  <span class={`seller-associate-badge is-${seller().associate.role}`}>{associateRoleLabel(seller().associate.role)}</span>
                </Show>
              </h1>
              <Show when={showTag()}><p class="seller-handle">@{tag()}</p></Show>
              <div class="seller-hero-meta">
                <Show when={country() && countryShort()}>
                  <p class="seller-country">
                    <Show
                      when={country().emoji}
                      fallback={<Show when={country().src}><img src={country().src} alt="" width="22" height="22" /></Show>}
                    >
                      <span aria-hidden="true">{country().emoji}</span>
                    </Show>
                    <span>({countryShort()})</span>
                  </p>
                </Show>
                <Show when={ready()}><span class="seller-badge seller-badge-ready">1-Day Ready</span></Show>
              </div>
            </div>
          </header>

          <MetricGrid>
            <Metric value={shown() == null || copyCount() == null ? '…' : copyCount()} label="Total items" />
            <Metric value={shown() == null ? '…' : uniqueItems()} label="Unique items" />
          </MetricGrid>

          <Alert message={error() && shown()?.length ? error() : ''} />

          <section class="panel shop-panel shop-terminal seller-shop-panel">
            <header class="panel-head shop-head">
              <h2>Shop</h2>
            </header>

            <div class="shop-toolbar seller-shop-tools" role="search">
              <input
                class="shop-search"
                type="search"
                placeholder="Search listings…"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                aria-label="Search listings"
                disabled={shown() == null}
              />
              <div class="shop-find">
                <select
                  aria-label="Condition"
                  value={condition()}
                  onChange={(event) => setCondition(event.currentTarget.value)}
                  disabled={shown() == null}
                >
                  <For each={SELLER_CONDITION_FILTERS}>{(opt) => <option value={opt.value}>{opt.label}</option>}</For>
                </select>
                <select
                  aria-label="Language"
                  value={language()}
                  onChange={(event) => setLanguage(event.currentTarget.value)}
                  disabled={shown() == null}
                >
                  <For each={SELLER_LANG_FILTERS}>{(code) => <option value={code}>{code || 'Any language'}</option>}</For>
                </select>
                <select
                  aria-label="Rarity"
                  value={rarity()}
                  onChange={(event) => setRarity(event.currentTarget.value)}
                  disabled={shown() == null}
                >
                  <For each={SELLER_RARITY_FILTERS}>{(opt) => <option value={opt.value}>{opt.label}</option>}</For>
                </select>
                <ShopToggle label="Reverse" pressed={reverse()} onToggle={setReverse} />
                <ShopToggle label="1st Ed." pressed={firstEdition()} onToggle={setFirstEdition} />
                <select
                  aria-label="Sort"
                  value={sort()}
                  onChange={(event) => setSort(event.currentTarget.value)}
                  disabled={shown() == null}
                >
                  <option value="price-desc">Price: high</option>
                  <option value="price-asc">Price: low</option>
                  <option value="name">Name</option>
                  <option value="qty">Quantity</option>
                </select>
              </div>
            </div>

            <p class="seller-result-count">
              <Show when={!(shown() == null || busy())} fallback="Loading…">
                <Show when={productCount()} fallback="No matching listings">
                  Showing <strong>{startIdx()}</strong>–<strong>{endIdx()}</strong> of{' '}
                  <strong>{productCount()}</strong>
                </Show>
              </Show>
            </p>

            <Show when={shown() != null} fallback={<SkeletonRows />}>
              <Show
                when={shown().length}
                fallback={(
                  <Show when={!busy()}>
                    <EmptyDesk title="No listings" lede={`${display()} has no live asks for these filters.`} />
                  </Show>
                )}
              >
                <ShopList class="seller-shop-list" offers={shownOffers()}>
                  <For each={rows()} keyed={(row) => row.offer.id || `${row.cardId}-${row.index}`}>
                    {(row) => (
                      <ShopListingRow
                        offer={row().enriched}
                        card={row().cardStub}
                        showCard
                        selected={listingSelected().has(listingSelectId(row().enriched))}
                        dragOffers={shopDragOffers(shownOffers(), listingSelected(), row().enriched)}
                        onCart={(qty) => {
                          const { offer, cardId, cardStub, enriched } = row();
                          if (!cardId || !offer.id) return;
                          const item = cartItemFromOffer(cardStub, enriched);
                          addCartItem(qty ? { ...item, qty } : item);
                        }}
                      />
                    )}
                  </For>
                </ShopList>
              </Show>
            </Show>

            <Show when={productCount() > PAGE_SIZE}>
              <div class="seller-pager">
                <button
                  type="button"
                  class="btn ghost"
                  disabled={safePage() <= 1 || busy()}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </button>
                <span class="seller-pager-status">
                  Page {safePage()} / {totalPages()}
                </span>
                <button
                  type="button"
                  class="btn ghost"
                  disabled={safePage() >= totalPages() || busy()}
                  onClick={() => setPage((p) => Math.min(totalPages(), p + 1))}
                >
                  Next
                </button>
              </div>
            </Show>
          </section>
        </div>
      </Show>
    </Show>
  );
}

/** /marketplace/:lang/users/:username — one shop per handle. */
export default function Seller() {
  const params = useParams();
  const handle = () => decodeURIComponent(String(params.username || '').trim());
  return (
    <Show when={handle()} keyed>
      {(name) => <SellerShop handle={name} lang={params.lang} />}
    </Show>
  );
}
