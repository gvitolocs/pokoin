import { noteCardView } from '@market/interest-profile.js';
import { afterHero, holdForHero } from '@market/hero-gate.js';
import { warmRecentCard, warmRecentsRail } from '@market/recents-rail.js';
import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  For,
  Match,
  onSettled,
  reconcile,
  Show,
  snapshot,
  Switch,
  untrack,
} from 'solid-js';
import { useLocation, useParams, useSearchParams } from '@solidjs/router';
import { useGameNavigate } from '../lib/game-navigate.js';
import {
  artistHref,
  artistSlug,
  cancelListing,
  cardFromCatalogRow,
  cardHref,
  deskArtUrl,
  dropListing,
  fetchArtistSummaries,
  fetchCanonicalPath,
  fetchCard,
  fetchCardSales,
  fetchExactNameCards,
  fetchListings,
  fetchPrintNationality,
  peekPrintNationality,
  fetchVersionSet,
  invalidateListings,
  imageSrc,
  mergeCreatedListing,
  neighborsOrPeek,
  omitListings,
  peekCanonicalPath,
  peekCard,
  peekHasListingRows,
  peekListings,
  peekRecentTile,
  postWatchlist,
  publicCardId,
  readWatchlistIds,
  rememberCardId,
  rememberCreatedListing,
  rememberNeighbors,
  setSlug,
  toggleWatchlist,
  versionsHref,
  warmupCard,
  warmupNeighbors,
} from '@market/api.js';
import {
  albumShade,
  cardShadeStyle,
  deskTheme,
  deskThemeVars,
  peekDeskIdentity,
  rarityDeskVars,
  rememberCardBucket,
  rememberDeskIdentity,
} from '@market/art-shade.js';
import {
  canonicalTarget,
  cleanPath,
  canUseNativeShare,
  catalogPrintings,
  CONDITIONS,
  copyText,
  DEAL_CONDS,
  formatChange72h,
  listedDealConditions,
  listedDealLanguages,
  matchDeal,
  shownDealCondition,
  moodCondition,
  pricedOffers,
  sortOffers,
} from '@market/card-desk.js';
import { cardStubFromRoute, mergeDeskCard, realPublicCardId } from '@market/card-stub.js';
import {
  deskClipCandidates,
  deskSetShortcuts,
  deskShowMoreVersions,
  mergePrintingRows,
  rarityVersions,
  versionOptionLabel,
} from '@market/card-versions.js';
import { ownerGameChoice } from '@market/card-response.js';
import { cartItemFromOffer } from '@market/cart-rows.js';
import { bundleReference, preloadDragImage, writeListingDrag } from '@market/chat-listing.js';
import { buyOfferSellable, dealBookRows } from '@market/deal-book.js';
import { offerPriceLabel, selectionBid, withHouseOffer } from '@market/buy-orders.js';
import { resolveDealLanguage, writeDealLanguage } from '@market/deal-pref.js';
import { game, gameHref, publicGamePath } from '@market/game.js';
import { cardDocumentTitle, displayName, printingIdentity } from '@market/identity.js';
import { deskLanguageChips, deskLanguageChoice } from '@market/listing-languages.js';
import { applyListingLive, subscribeListingLive } from '@market/listing-live.js';
import { conditionChipSrc, publicListingSellerName, sellerHref } from '@market/listing-meta.js';
import { flagSrc, languagesForNationality } from '@market/locale.js';
import { currencyFromSearch, fiatFromPkn, pknRateLabel } from '@market/pkn.js';
import { pokemonHref, speciesFromCard } from '@market/pokemon-hubs.js';
import { clearActiveDeskCard, setActiveDeskCard } from '@market/poko-chat.js';
import { authFrom } from '@market/punchouts.js';
import { rarityKindLabel, storedRarityKind } from '@market/rarity-theme.js';
import { preloadRelatedThumbs, relatedFromPage } from '@market/related-cards.js';
import {
  breadcrumbJsonLd,
  cardImageAlt,
  cardSeoDescription,
  languageHrefFromNationality,
  pickRelatedCards,
  productJsonLd,
  rarityHref,
} from '@market/seo.js';
import { eraHref, expansionLogoSrc, tcgEra } from '@market/set-logos.js';
import { listingSelectId, shopDragOffers } from '@market/shop-marquee.js';
import { peekCardSales, rememberStaleCardSales, saveCardSales } from '@market/sold-sales-cache.js';
import { soldGraphView, soldTraitsForGraphDay } from '@market/sold-sales.js';
import { soldSeriesColor } from '@market/sold-graph.js';
import { Action, track } from '@market/track.js';
import CardArt from '../components/CardArt.jsx';
import CardSelectGrid from '../components/CardSelectGrid.jsx';
import DeskArtFrame, { Chevron, dragThisCard, isLandscapeDesk } from '../components/desk/DeskArtFrame.jsx';
import BuyOffers from '../components/deal/BuyOffers.jsx';
import CheapestListings from '../components/deal/CheapestListings.jsx';
import ReverseSparkles from '../components/desk/ReverseSparkles.jsx';
import { REVERSE_SCAN_LABEL, reverseScanUrl } from '@market/reverse-scans.js';
import OfferBar from '../components/desk/OfferBar.jsx';
import QuickSellDialog from '../components/buysell/QuickSellDialog.jsx';
import ListingForm from '../components/desk/ListingForm.jsx';
import NativeSales from '../components/desk/NativeSales.jsx';
import RelatedCards from '../components/desk/RelatedCards.jsx';
import SeoCrumbs from '../components/desk/SeoCrumbs.jsx';
import ShopHeader, { Ico } from '../components/desk/ShopHeader.jsx';
import ShopListingRow, { ShopList } from '../components/desk/ShopListing.jsx';
import { isVaultOffer, splitVaultOffers } from '@market/vault.js';
import SilverHead from '../components/desk/SilverHead.jsx';
import SoldPriceGraph from '../components/desk/SoldPriceGraph.jsx';
import ExpansionMark from '../components/ExpansionMark.jsx';
import PriceStack from '../components/PriceStack.jsx';
import SeoHead from '../components/SeoHead.jsx';
import { handOffCard, peekHandoffCard } from '../lib/card-handoff.js';
import { createBuyBook, sellTarget } from '../lib/buy-book.js';
import { whenIdle } from '../lib/idle.js';
import { readDeskListings, readDeskVersions, writeDeskListings, writeDeskVersions } from '@market/desk-listings-store.js';
import { authUid, authUser, getBearer, signedIn } from '../stores/auth.js';
import { buyerCurrency, buyerFormat, buyerParts, buyerPending, sellerSettings } from '../stores/buyer.js';
import { addCartItem } from '../stores/cart.js';
import { authSession } from '../stores/session.js';
import { listingSelected } from '../lib/select-band.js';
import { afterPaint } from '../lib/yield-nav.js';
import { BUYSELL_PREVIEW_BANNER, previewListings, previewScale } from './buysell-preview-fixture.js';

/** A hover / intent prefetch this recent counts as the desk's own first read. */
const PREFETCH_FRESH_MS = 10_000;

const DESK_VARS = ['--desk-bg', '--desk-surface', '--desk-raised', '--desk-hero', '--desk-hero-border', '--desk-border', '--desk-tint'];

function clearDeskTheme() {
  const root = document.documentElement;
  root.classList.remove('desk-tinted', 'desk-rainbow', 'desk-gold', 'desk-ghost');
  for (const key of DESK_VARS) root.style.removeProperty(key);
}

function rowsFrom(list) {
  return (list || []).map(cardFromCatalogRow).filter((row) => row.id);
}

/** Store rows are copies: reconcile writes into them, never into the listings cache. */
function offerCopies(rows) {
  return (rows || []).map((row) => ({ ...row }));
}

/**
 * Card desk route. One desk per `lang:cardId`:
 * ‹ › and the version select remount it, which resets the per-card state the
 * React page resets by hand. The theme and the Poko desk card are cleared only
 * when the route itself unmounts, so a neighbour step never flashes untinted.
 */

export default function Card() {
  const params = useParams();
  const location = useLocation();
  const navigate = useGameNavigate();
  const lang = () => params.lang || 'en';
  const cardId = () => realPublicCardId(params.cardId);
  const deskKey = createMemo(() => `${lang()}:${cardId()}`);

  // A provisional public id redirects to the real one (React useLayoutEffect).
  const idKey = createMemo(() => `${params.cardId}|${cardId()}`);
  createEffect(idKey, () => {
    const raw = String(untrack(() => params.cardId));
    const real = String(untrack(cardId));
    if (raw === real) return;
    const path = untrack(() => location.pathname);
    navigate(`${path.replace(`/cards/${raw}`, `/cards/${real}`)}${untrack(() => location.search)}`, {
      replace: true,
      scroll: false,
    });
  });

  onSettled(() => () => {
    clearDeskTheme();
    clearActiveDeskCard();
  });

  return (
    // The callback must take the key: Show only remounts a keyed child that
    // declares a parameter (a zero-arity function is rendered as-is).
    <Show when={deskKey()} keyed>
      {(key) => (
        <CardDesk
          lang={key.slice(0, key.indexOf(':'))}
          cardId={key.slice(key.indexOf(':') + 1)}
          slug={params.slug || ''}
        />
      )}
    </Show>
  );
}

function CardDesk(props) {
  const cardId = untrack(() => String(props.cardId));
  const lang = untrack(() => props.lang);
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const navigate = useGameNavigate();
  const pinnedCurrency = () => currencyFromSearch(location.search);
  // The preview pile's row count, or 0 for a normal desk. Read once: the switch
  // is a load-test dial, not something the desk reacts to.
  const deskPreview = untrack(() => previewScale(searchParams));

  // First paint: URL stub + recent tile + remembered identity + the clicked tile.
  const stubCard = createMemo(() => {
    const route = cardStubFromRoute({ cardId, lang, slug: props.slug || '' });
    return mergeDeskCard(
      mergeDeskCard(mergeDeskCard(route, peekRecentTile(cardId)), peekDeskIdentity(cardId)),
      peekHandoffCard(cardId),
    );
  });

  const cached = peekCard(cardId, { lang });
  const listed = peekListings(cardId);
  // A reload paints the last answer of this desk; the live read reconciles it.
  const deskGame = untrack(() => game().id);
  const stored = peekHasListingRows(listed) ? null : readDeskListings(deskGame, cardId);
  let paintedFromStore = Boolean(stored);
  const firstStub = untrack(stubCard);
  const [page, setPage] = createSignal(
    cached
      ? { ...cached, neighbors: neighborsOrPeek(cardId, cached.neighbors) }
      : (firstStub ? { card: firstStub, versions: [], neighbors: neighborsOrPeek(cardId) } : null),
  );
  const [shop, setShop] = createStore({
    offers: offerCopies(peekHasListingRows(listed) ? listed.listings : (stored ? stored.rows : (cached?.offers || []))),
  });
  const [offersReady, setOffersReady] = createSignal(peekHasListingRows(listed) || Boolean(stored));
  const [error, setError] = createSignal('');
  // Same-id cards of other games, offered when a game-less link cannot pick one.
  const [ownerChoices, setOwnerChoices] = createSignal([]);
  const [zoom, setZoom] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [watched, setWatched] = createSignal(readWatchlistIds().includes(cardId));
  const [offerSort, setOfferSort] = createSignal('price');
  const [condition, setCondition] = createSignal('');
  const [language, setLanguage] = createSignal('');
  // The full Shop is the desk's last row and starts closed: See all in the
  // listings cell opens it in place. Nothing in the URL names a Shop filter today,
  // so there is no deep link that could ask for it open from the start.
  const [shopOpen, setShopOpen] = createSignal(false);
  // Both listing cells cap their rows by viewport — three on desktop, two on a phone —
  // and the same cap decides the See all count, so it is a signal and not a CSS hide.
  const [deskWidth, setDeskWidth] = createSignal(window.innerWidth);
  createEffect(
    () => deskWidth() > 0,
    () => {
      const onResize = () => setDeskWidth(window.innerWidth);
      window.addEventListener('resize', onResize, { passive: true });
      return () => window.removeEventListener('resize', onResize);
    },
  );
  const deskRows = () => dealBookRows(deskWidth());
  const [dealLang, setDealLang] = createSignal('');
  const [dealCond, setDealCond] = createSignal('');
  // The band chips are the desk's one selection: they pick the Best Deal and
  // what the sold graph plots. A chip the visitor pressed is kept as pressed,
  // listed or not; until then the desk shows the best facet that has a listing.
  const [dealReverse, setDealReverse] = createSignal(false);
  const [condPinned, setCondPinned] = createSignal(false);
  const [condAny, setCondAny] = createSignal(false);
  const [langAny, setLangAny] = createSignal(false);
  const [langPinned, setLangPinned] = createSignal(false);
  const [listingBusy, setListingBusy] = createSignal(false);
  const [shopError, setShopError] = createSignal('');
  const [editingOffer, setEditingOffer] = createSignal(null);
  // The rarity select as this desk last showed it, so it does not swap in
  // after the collector label once the name snapshot answers.
  const storedVersions = readDeskVersions(deskGame, cardId)?.rows || [];
  const [namePrintings, setNamePrintings] = createSignal(mergePrintingRows(catalogPrintings(cached?.rarities), storedVersions));
  const [artPrintings, setArtPrintings] = createSignal(rowsFrom(cached?.versions));
  const [salesSlices, setSalesSlices] = createSignal(peekCardSales(cardId)?.slices ?? null);
  const [salesCondition, setSalesCondition] = createSignal('');
  const [salesLanguage, setSalesLanguage] = createSignal('');
  const [salesReverse, setSalesReverse] = createSignal(false);
  const [salesFirstEdition, setSalesFirstEdition] = createSignal(false);
  const [salesGraded, setSalesGraded] = createSignal(false);
  const [setNationality, setSetNationality] = createSignal(untrack(() => peekPrintNationality(setSlug(
    page()?.card?.set || page()?.card?.set_name || stubCard()?.set || stubCard()?.set_name || '',
  ))));
  const [artistCover, setArtistCover] = createSignal('');
  let disposed = false;
  let viewed = false;
  // Related tiles and the catalog fold sit below the desk on every layout: they
  // mount one frame after the desk paints, so a tile click paints sooner.
  const [later, setLater] = createSignal(false);
  let laterFrame = 0;
  let laterTimer = 0;
  let listingsSeq = 0;
  let copiedTimer = 0;
  let zoomEl;

  function setOffers(rows) {
    setShop((draft) => {
      reconcile(offerCopies(rows), 'id')(draft.offers);
    });
  }

  /** Same freshness rule as React: an empty refetch never wipes painted rows. */
  function refreshListings(seq, maxAgeMs = 0) {
    return fetchListings(cardId, { fresh: true, maxAgeMs }).then((list) => {
      const rows = list.listings || [];
      // Stored even when this desk was replaced (canonical redirect, ‹ ›).
      if (seq === listingsSeq) writeDeskListings(deskGame, cardId, rows);
      if (disposed || seq !== listingsSeq) return;
      // A stored answer is old: an empty live one clears it.
      if (rows.length || !shop.offers.length || paintedFromStore) setOffers(rows);
      paintedFromStore = false;
      setOffersReady(true);
    });
  }

  function replaceToCanonical(path) {
    const here = untrack(() => location.pathname);
    const next = canonicalTarget(path, here);
    if (!next) return;
    const prefixed = publicGamePath(next, game().id) || next;
    if (cleanPath(prefixed) === cleanPath(here)) return;
    // The query rides along: the canonical redirect must not drop ?mypokoinPreview (or any other switch).
    navigate(`${prefixed}${untrack(() => location.search)}`, { replace: true, scroll: false });
  }

  function showCard(data) {
    if (disposed || !data?.card) return;
    const neighborWindow = neighborsOrPeek(cardId, data.neighbors);
    // The next card's scan waits for this one's (market/src/hero-gate.js).
    afterHero(() => warmupNeighbors(neighborWindow, { lang }));
    const current = untrack(page);
    const { offers: _pageOffers, ...rest } = data;
    const merged = mergeDeskCard(current?.card, data.card);
    rememberCardId(merged);
    // This card now leads Recently seen: its rail thumb and the rest of the
    // stored rail are ready before the marketplace opens (after this hero).
    afterHero(() => whenIdle(() => {
      warmRecentCard(merged);
      void warmRecentsRail();
    }));
    // The visitor's own view history, on their device, for search predictions.
    noteCardView(merged, { print: merged?.nationality });
    setPage({
      ...rest,
      card: merged,
      version: data.version || merged.version || current?.version || '',
      neighbors: neighborWindow,
    });
    const card = mergeDeskCard(untrack(stubCard), data.card);
    rememberNeighbors(card, data.neighbors);
    const clip = rowsFrom(data.versions);
    if (clip.length) setArtPrintings(clip);
    const rarities = catalogPrintings(data.rarities);
    if (rarities.length) setNamePrintings((rows) => mergePrintingRows(rows, rarities));
    setWatched(readWatchlistIds().includes(String(card.id)));
    // One view per desk, however many times its page payload lands.
    if (!viewed) track(Action.viewCard, card);
    viewed = true;
    if (card.canonicalPath) replaceToCanonical(card.canonicalPath);
  }

  // Network starts with the component, not after the first paint.
  // The tile's intent prefetch is this desk's listings read: adopt it.
  // `?mypokoinPreview=100` is the pile the row caps are proven against: the desk
  // paints that many fixture listings and asks the listings read for none.
  listingsSeq += 1;
  if (deskPreview) {
    // A store write is not allowed while the component is still being set up,
    // so the fixture pile lands on the next microtask like a network answer.
    queueMicrotask(() => {
      if (disposed) return;
      setOffers(previewListings(deskPreview, cardId));
      setOffersReady(true);
    });
  } else {
    refreshListings(listingsSeq, PREFETCH_FRESH_MS).catch(() => {
      if (!disposed) setOffersReady(true);
    });
  }
  // Not painted from a peek: a stored copy of any age paints at once, and the
  // revalidated page merges in place through showCard.
  fetchCard(cardId, {
    lang,
    slug: untrack(() => props.slug || ''),
    includeOffers: false,
    fresh: Boolean(cached),
    onUpdate: showCard,
  })
    .then(showCard)
    .catch((err) => {
      if (disposed) return;
      if (err.status === 404) {
        // Another TCG's card behind a game-less link: reload under its slug
        // (the router basename changes), never "Card market not found."
        const { pathname, search, hash } = window.location;
        const owner = ownerGameChoice(err, { gameId: game().id, pathname, search, hash });
        if (owner.location) {
          window.location.replace(owner.location);
          return;
        }
        setOwnerChoices(owner.choices);
        setPage(null);
        setError(err.message || 'Card not found.');
        return;
      }
      if (!cached && !untrack(stubCard)) setError(err.message || 'Card not found.');
    });
  fetchCardSales(cardId, { slices: true }).then((data) => {
    if (disposed) return;
    if (!Array.isArray(data?.slices)) {
      if (!peekCardSales(cardId)) setSalesSlices([]);
      return;
    }
    saveCardSales(cardId, data.slices);
    setSalesSlices(data.slices);
  }).catch(() => {
    if (disposed || peekCardSales(cardId)) return;
    const stale = rememberStaleCardSales(cardId);
    setSalesSlices(stale?.slices ?? []);
  });
  function showVersionSet(data) {
    if (disposed) return;
    const rows = rowsFrom(data?.printings);
    if (rows.length) setArtPrintings(rows);
  }
  fetchVersionSet(cardId, { onUpdate: showVersionSet }).then(showVersionSet).catch(() => {
    /* Keep marketplace-card-page `versions` so 2–6 reprints still paint. */
  });
  if (cached) rememberNeighbors(cached.card, cached.neighbors);
  // Arrows painted from the cache: warm the next hop now, not after this
  // card's own page loads, so fast clicking keeps finding neighbours.
  if (!cached) {
    const painted = untrack(page)?.neighbors;
    if (painted?.prev?.length || painted?.next?.length) afterHero(() => warmupNeighbors(painted, { lang }));
  }
  const landedWithoutSlug = !untrack(() => props.slug);
  const knownPath = landedWithoutSlug
    ? (peekCanonicalPath(cardId, { lang }) || firstStub?.canonicalPath || firstStub?.canonical_path || '')
    : '';
  if (knownPath) {
    // Redirect-on-render belongs in setup (router docs): navigate() creates
    // router primitives, which an owner-backed onSettled forbids.
    replaceToCanonical(knownPath);
  } else if (landedWithoutSlug) {
    fetchCanonicalPath(cardId, { lang }).then((path) => {
      if (!disposed && path) replaceToCanonical(path);
    }).catch(() => {});
  }

  onSettled(() => {
    laterFrame = requestAnimationFrame(() => {
      laterTimer = window.setTimeout(() => setLater(true), 0);
    });
    const unsubscribe = subscribeListingLive(cardId, (event) => {
      if (!shop.offers.length) return;
      const plain = snapshot(shop.offers);
      const next = applyListingLive(plain, event);
      if (next !== plain) setOffers(next);
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(laterFrame);
      window.clearTimeout(laterTimer);
      unsubscribe?.();
      window.clearTimeout(copiedTimer);
    };
  });

  // Print nationality of the expansion fills a card without one.
  const setNameForNationality = createMemo(() => page()?.card?.set || page()?.card?.set_name
    || stubCard()?.set || stubCard()?.set_name || '');
  createEffect(setNameForNationality, (name) => {
    const slug = setSlug(name);
    if (!slug) {
      setSetNationality('');
      return undefined;
    }
    const known = peekPrintNationality(slug);
    if (known) setSetNationality(known);
    let live = true;
    fetchPrintNationality(slug).then((value) => {
      if (live) setSetNationality(value);
    });
    return () => {
      live = false;
    };
  });

  const card = createMemo(() => {
    const row = mergeDeskCard(stubCard(), page()?.card || null);
    if (!row) return { id: cardId, card_id: cardId };
    const nationality = String(row.nationality || setNationality() || '').trim();
    if (!nationality || row.nationality === nationality) return row;
    return { ...row, nationality };
  });
  const themeCard = () => page()?.card || stubCard() || { id: cardId, card_id: cardId };
  const pageTheme = createMemo(() => deskTheme(themeCard()));

  // Sold graph.
  const salesNationality = () => page()?.card?.nationality || stubCard()?.nationality || setNationality();
  const salesFilterState = () => ({
    nationality: salesNationality(),
    language: salesLanguage(),
    condition: salesCondition(),
    reverse: salesReverse(),
    firstEdition: salesFirstEdition(),
    graded: salesGraded(),
  });
  const salesView = createMemo(() => soldGraphView(salesSlices() || [], salesFilterState()));
  const salesSeries = () => (salesSlices() == null ? null : salesView().series);
  const graphFilters = () => ({
    ...salesView().filters,
    languages: languagesForNationality(salesNationality(), salesView().filters.languages),
  });
  // Keep the chip pressed-state on the effective flags: a printing that never
  // sold the standard variant snaps Reverse/1st Ed./Graded back on.
  createEffect(() => salesView().flags, (flags) => {
    if (!flags) return;
    if (flags.reverse !== untrack(salesReverse)) setSalesReverse(flags.reverse);
    if (flags.firstEdition !== untrack(salesFirstEdition)) setSalesFirstEdition(flags.firstEdition);
    if (flags.graded !== untrack(salesGraded)) setSalesGraded(flags.graded);
  });

  createEffect(card, (row) => {
    if (row?.id || row?.name) setActiveDeskCard(row);
  });

  // Every printing with this exact name (rarity select, related tiles).
  const exactName = createMemo(() => String(page()?.card?.name || stubCard()?.name || '').trim());
  createEffect(exactName, (name) => {
    if (!name) return undefined;
    const ac = new AbortController();
    fetchExactNameCards(name, { signal: ac.signal, lang })
      .then((rows) => {
        if (ac.signal.aborted || !rows.length) return;
        setNamePrintings((current) => mergePrintingRows(current, rows));
      })
      .catch(() => {});
    return () => ac.abort();
  });

  createEffect(zoom, (open) => {
    if (open && zoomEl && !zoomEl.open) zoomEl.showModal();
  });

  // Drag images for the set / artist links, and the artist album cover.
  createEffect(() => page()?.card, (row) => {
    if (!row) return undefined;
    const setTitle = row.set || row.setName || row.expansion_name || '';
    const logo = expansionLogoSrc({ slug: setSlug(setTitle), name: setTitle });
    if (logo) preloadDragImage(logo);
    const slug = artistSlug(row.artist || row.illustrator || '');
    if (!slug) {
      setArtistCover('');
      return undefined;
    }
    let live = true;
    fetchArtistSummaries({ limit: 1000 }).then((data) => {
      const src = (data?.artists || []).find((item) => item.slug === slug)?.imageUrl || '';
      if (!live) return;
      setArtistCover(src);
      if (src) preloadDragImage(src);
    }).catch(() => {});
    return () => {
      live = false;
    };
  });

  createEffect(() => page()?.card || stubCard(), (row) => {
    if (!row) return;
    rememberDeskIdentity({ ...row, id: row.id || row.card_id || cardId });
    const shade = albumShade(row);
    if (shade) rememberCardBucket(row.id || row.card_id || cardId, shade);
  });

  // Desk tint on <html>; removed only when the route unmounts (no class reset between cards).
  createEffect(
    () => {
      const kind = storedRarityKind(themeCard());
      return { kind, vars: rarityDeskVars(kind) || deskThemeVars(pageTheme()) };
    },
    ({ kind, vars }) => {
      const root = document.documentElement;
      if (vars) {
        for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
      }
      if (vars || kind) root.classList.add('desk-tinted');
      root.classList.toggle('desk-rainbow', kind === 'rainbow');
      root.classList.toggle('desk-gold', kind === 'gold');
      root.classList.toggle('desk-ghost', kind === 'ghost');
    },
  );

  // Derived desk view.
  const identity = createMemo(() => printingIdentity(card()));
  // Strings children key their own work on (hero <img>, links) are memos, so a
  // hydrate that only adds fields does not re-run it.
  const fromPath = createMemo(() => card().canonicalPath || window.location.pathname);
  // The exact URL the boot script and the router preloaded (card.deskArtUrl
  // from the card page), so this <img> reuses that download.
  const art = createMemo(() => deskArtUrl(card()));
  // Gold sparkles: the verified reverse-holo / mirror scan of this printing.
  // The toggle belongs to one card id, so the next desk opens on its own scan.
  const reverseScan = createMemo(() => reverseScanUrl(card()));
  const [reverseFor, setReverseFor] = createSignal('');
  const reverseOn = () => Boolean(reverseScan()) && reverseFor() === String(card().id);
  const toggleReverse = () => setReverseFor(reverseOn() ? '' : String(card().id));
  const heroArt = createMemo(() => (reverseOn() ? reverseScan() : art()));
  // A new hero closes the gate until DeskArtFrame reports it loaded or failed.
  createEffect(art, (url) => {
    if (url) holdForHero();
  });
  const heroShade = () => albumShade(card());
  const rarityKind = () => storedRarityKind(card());
  const setName = createMemo(() => identity().set || '');
  const setHref = () => (setName() ? `/marketplace/sets/${setSlug(setName())}` : '');
  const artist = createMemo(() => identity().artist || page()?.artist?.name || page()?.artist?.illustrator || '');
  const artistPath = () => (artist() ? artistHref(artist(), lang) : '');
  const identityEmoji = () => card().emoji || card().cardIdentityEmoji || '';
  const neighborWindow = createMemo(() => neighborsOrPeek(publicCardId(card()), page()?.neighbors));
  const prevNav = () => neighborWindow().prev?.[0] || null;
  const nextNav = () => neighborWindow().next?.[0] || null;
  const nativeLive = createMemo(() => pricedOffers(shop.offers));
  const listedDealLangs = createMemo(() => listedDealLanguages(shop.offers, card()));
  // Languages with a priced listing — the data the chips are cut by. Empty
  // while the desk is still loading, when it knows nothing about any language.
  const listedLangData = createMemo(() => (offersReady() ? listedDealLangs() : []));
  // With the Reverse chip on, only reverse listings can be the Best Deal.
  const dealRows = createMemo(() => (dealReverse() ? nativeLive().filter((offer) => offer?.reverse) : nativeLive()));
  const shownLang = createMemo(() => {
    const row = card();
    return deskLanguageChoice({
      nationality: row.nationality,
      setName: identity().set || row.set,
      releaseLanguages: row.releaseLanguages,
      data: listedLangData(),
      // The chip the visitor pressed, else the language the desk picked for
      // them. Neither is a choice once the printing cannot exist in it.
      chosen: (langPinned() && dealLang())
        ? String(dealLang()).toUpperCase()
        : resolveDealLanguage({
          selected: dealLang() || 'EN',
          listed: listedLangData(),
          country: sellerSettings()?.shipFromCountry,
        }),
    });
  });
  // A pressed grade is kept as pressed. Before any press: the chosen grade when
  // it is listed in the shown language, else the best one that is.
  const shownCond = createMemo(() => {
    const wanted = dealCond() || 'NM';
    if (condPinned()) return wanted;
    return offersReady() ? shownDealCondition(dealRows(), shownLang(), wanted, card()) : wanted;
  });
  // Pressing the ringed chip again lets go of it: no grade (or no language) is
  // picked, which reads as any. The Best Deal is then the cheapest listing of
  // any grade or language and the graph plots them all. The offer bar and the
  // sell strip still need one concrete facet, so they keep the last one shown.
  const pickedCond = () => (condAny() ? '' : shownCond());
  const pickedLang = () => (langAny() ? '' : shownLang());
  const pickedLabel = () => [pickedCond() || 'any condition', pickedLang() || 'any language'].join(' · ');
  const dealPick = createMemo(() => (offersReady() ? matchDeal(dealRows(), pickedLang(), pickedCond(), card()) : null));
  // The sold graph plots what the chips picked. It has no menus of its own.
  createEffect(() => [pickedCond(), pickedLang(), dealReverse()], ([cond, code, reverse]) => {
    setSalesCondition(cond);
    setSalesLanguage(code);
    setSalesReverse(Boolean(reverse));
  });
  const showReverseChip = () => Boolean(salesView().chips?.reverse) || nativeLive().some((offer) => offer?.reverse);
  /** What the graph is plotting, said in the chips' own words. */
  const graphScope = () => {
    const filters = graphFilters();
    const cond = (filters.conditions || []).includes(pickedCond()) ? pickedCond() : '';
    const code = (filters.languages || []).includes(pickedLang()) ? pickedLang() : '';
    const parts = [cond || 'All conditions', code || 'All languages'];
    if (salesReverse()) parts.push(game().id === 'pokemon' ? 'Reverse' : 'Foil');
    const missing = [cond ? '' : pickedCond(), code ? '' : pickedLang()].filter(Boolean);
    return missing.length ? `${parts.join(' · ')} (no ${missing.join(' · ')} sales yet)` : parts.join(' · ');
  };
  // The graph plots exactly what the chips pick. The sales view falls back to
  // every condition (or language) when the picked one never sold, which drew
  // other grades' sales and their unit count under a "PO" pick. A pick with no
  // sales of its own is an empty graph that says so.
  const graphMissing = () => {
    const filters = graphFilters();
    return [
      pickedCond() && !(filters.conditions || []).includes(pickedCond()) ? pickedCond() : '',
      pickedLang() && !(filters.languages || []).includes(pickedLang()) ? pickedLang() : '',
    ].filter(Boolean);
  };
  const graphSeries = () => {
    const series = salesSeries();
    if (series == null || !graphMissing().length) return series;
    return { ...series, days: [], soldQty: 0, sampleCount: 0 };
  };
  const graphEmptyLabel = () => {
    if (graphMissing().length) return `No ${graphMissing().join(' · ')} sales yet`;
    // The grade and the language both sold, just never together.
    return pickedCond() || pickedLang() ? `No ${pickedLabel()} sales yet` : '';
  };
  // Comparison: every condition / language / Reverse combination the visitor
  // picks stays on the graph, each line in its own colour with its own legend
  // entry, until they take it off there. The first language keeps the grade
  // colours (Near Mint green, Moderately Played yellow…); each further language
  // gets its own palette (light blue, magenta…), so a language is never read as
  // a grade; Reverse is the same colour, dashed.
  const GRAPH_PICKS_MAX = 8;
  const facetKey = (facet) => `${facet.cond}|${facet.lang}|${facet.reverse ? 'r' : ''}`;
  const facetLabel = (facet) => [facet.cond, facet.lang, facet.reverse ? (game().id === 'pokemon' ? 'Reverse' : 'Foil') : ''].filter(Boolean).join(' · ');
  const [graphPicks, setGraphPicks] = createSignal([]);
  createEffect(
    () => (offersReady() && pickedCond() && pickedLang() ? facetKey({ cond: pickedCond(), lang: pickedLang(), reverse: dealReverse() }) : ''),
    (key) => {
      if (!key) return;
      const list = untrack(graphPicks);
      if (list.some((facet) => facetKey(facet) === key)) return;
      const [cond, code, flag] = key.split('|');
      setGraphPicks([...list, { cond, lang: code, reverse: flag === 'r' }].slice(-GRAPH_PICKS_MAX));
    },
  );
  /** The palette of a language is its place among the languages picked so far. */
  const facetColor = (facet) => {
    const order = [...new Set(graphPicks().map((row) => row.lang))];
    return soldSeriesColor(facet.cond, Math.max(0, order.indexOf(facet.lang)));
  };
  const currentFacet = () => (pickedCond() && pickedLang() ? { cond: pickedCond(), lang: pickedLang(), reverse: dealReverse() } : null);
  const graphColor = () => (currentFacet() ? facetColor(currentFacet()) : '');
  const graphOverlays = () => {
    const now = currentFacet() ? facetKey(currentFacet()) : '';
    return graphPicks()
      .filter((facet) => facetKey(facet) !== now)
      .map((facet) => {
        const view = soldGraphView(salesSlices() || [], {
          ...salesFilterState(), condition: facet.cond, language: facet.lang, reverse: facet.reverse,
        });
        // The view falls back to every grade or language when the facet never
        // sold (or only sold the other finish): that is not this facet's line.
        const has = (view.filters.conditions || []).includes(facet.cond)
          && languagesForNationality(salesNationality(), view.filters.languages).includes(facet.lang)
          && Boolean(view.flags?.reverse) === Boolean(facet.reverse);
        const days = has && Array.isArray(view.series?.days) ? view.series.days : [];
        return { key: facetKey(facet), days, color: facetColor(facet), label: facetLabel(facet), dashed: facet.reverse };
      })
      .filter((row) => row.days.length);
  };
  const removeGraphPick = (key) => setGraphPicks(graphPicks().filter((facet) => facetKey(facet) !== key));
  const graphPickedLabel = () => (currentFacet() ? facetLabel(currentFacet()) : pickedLabel());
  // The graph's axis is in the visitor's currency, like its tooltip: how many
  // units of it one PKN is. 1 while the currency is unknown, so the axis is PKN.
  const graphAxisFactor = () => fiatFromPkn(1, buyerCurrency(pinnedCurrency()) || 'PKN') || 1;
  const lastDayPkn = () => buyerFormat(salesSeries()?.lastMedianPkn, true, pinnedCurrency());
  const [priceHelp, setPriceHelp] = createSignal(false);
  const pricePending = () => !pinnedCurrency() && buyerPending();
  const change72h = () => formatChange72h(salesSeries()?.change24hPct);
  const canBuy = () => Boolean(dealPick());
  const listedCondSet = createMemo(() => new Set(listedDealConditions(dealRows(), pickedLang(), card()).map((row) => row.value)));
  const listedLangSet = createMemo(() => new Set(listedDealLangs()));
  const allDealLangs = createMemo(() => {
    const row = card();
    return deskLanguageChips({
      nationality: row.nationality,
      setName: identity().set || row.set,
      releaseLanguages: row.releaseLanguages,
      data: listedLangData(),
    });
  });
  const languages = createMemo(() => languagesForNationality(
    card().nationality,
    [...new Set(shop.offers.map((row) => String(row.language || '').toUpperCase()).filter(Boolean))],
  ));
  const collector = () => identity().number || '';
  const versionRows = createMemo(() => rarityVersions(card(), namePrintings()));
  createEffect(versionRows, (rows) => {
    if (rows.length > 1) writeDeskVersions(deskGame, cardId, rows);
  });
  const versionLabel = () => versionOptionLabel(card()) || collector();
  const clipPrintings = createMemo(() => deskClipCandidates(artPrintings(), page()?.versions));
  const setShortcuts = createMemo(() => deskSetShortcuts(card(), clipPrintings()));
  const showMoreVersions = createMemo(() => deskShowMoreVersions(card(), {
    nameRows: namePrintings(),
    clipRows: clipPrintings(),
    versionCount: page()?.versionCount,
  }));
  const species = createMemo(() => speciesFromCard(card()));
  const eraName = createMemo(() => tcgEra(card()));
  const eraPath = () => (eraName() ? eraHref(eraName()) : '');
  const rarityPath = () => (identity().rarity ? rarityHref(identity().rarity, lang) : '');
  // Precomputed neighbours ride on card-page: the panel paints from them as
  // soon as the page is there (prefetch cache included). The client-side picker
  // and its name / version-set pools are only the fallback.
  const serverRelated = createMemo(() => relatedFromPage(page(), cardId), {
    equals: (a, b) => a.length === b.length && a.every((row, index) => String(row.id) === String(b[index].id)),
  });
  createEffect(serverRelated, (rows) => {
    // Low priority, behind the desk scan; the tiles reuse these downloads.
    // Behind the desk scan: the thumbnails wait for it (market/src/hero-gate.js).
    if (rows.length) afterHero(() => preloadRelatedThumbs(rows));
  });
  const related = createMemo(() => (serverRelated().length ? serverRelated() : pickRelatedCards(card(), [
    clipPrintings(),
    namePrintings(),
    neighborWindow().prev,
    neighborWindow().next,
  ], 12)));
  const cardPath = createMemo(() => card().canonicalPath || cardHref(card()));
  const publicCardPath = createMemo(() => publicGamePath(cardPath(), game().id) || cardPath());
  const speciesHref = () => (species() ? pokemonHref(card(), lang) : '');
  const seoCrumbs = createMemo(() => [
    { name: 'Marketplace', href: '/marketplace' },
    species()
      ? { name: species().name, href: speciesHref() }
      : { name: 'Pokémon', href: `/marketplace/${lang}/pokemon` },
    eraName() ? { name: eraName(), href: eraPath() } : null,
    setName() ? { name: setName(), href: setHref() } : null,
    { name: displayName(card()) || 'Card' },
  ]);
  const relatedHubs = createMemo(() => {
    const row = card();
    return [
      species() ? { name: `All ${species().name}`, href: speciesHref() } : null,
      setName() && setHref() ? { name: setName(), href: setHref() } : null,
      artist() && artistPath() ? { name: artist(), href: artistPath() } : null,
      eraName() && eraPath() ? { name: eraName(), href: eraPath() } : null,
      identity().rarity && rarityPath() ? { name: identity().rarity, href: rarityPath() } : null,
      row.nationality ? {
        name: `${String(row.nationality).charAt(0).toUpperCase()}${String(row.nationality).slice(1)} print`,
        href: languageHrefFromNationality(row.nationality, lang),
      } : null,
    ].filter(Boolean);
  });
  const jsonLd = () => {
    const row = card();
    return [
      productJsonLd(row, {
        url: `https://pokoin.com${publicCardPath()}`,
        offers: nativeLive(),
        currency: pinnedCurrency() && pinnedCurrency() !== 'PKN' ? pinnedCurrency() : '',
        listingId: new URLSearchParams(location.search).get('listing') || '',
        referencePkn: row?.price || row?.pricePkn || 0,
        game: game().id,
      }),
      breadcrumbJsonLd(seoCrumbs().filter(Boolean).map((crumb) => ({
        name: crumb?.name,
        href: crumb?.href ? publicGamePath(crumb.href, game().id) : undefined,
      }))),
    ];
  };

  // Shop.
  const offers = createMemo(() => {
    const nationality = page()?.card?.nationality || stubCard()?.nationality || setNationality();
    const allowed = languagesForNationality(nationality, language() ? [language()] : []);
    const shopLanguage = allowed.length ? language() : '';
    const cond = condition();
    const filtered = shop.offers.filter((offer) => {
      // Same grades as the condition chips: LP / Lightly Played is SP.
      if (cond && moodCondition(offer) !== cond) return false;
      if (shopLanguage && String(offer.language || '').toUpperCase() !== shopLanguage) return false;
      return true;
    });
    return sortOffers(filtered, offerSort());
  });
  // The Vault (Pokoin's own stock) gets its own panel; the Shop lists everyone else.
  const split = createMemo(() => splitVaultOffers(offers()));
  const mineIds = createMemo(() => {
    // The cached session names the seller before Firebase answers.
    const uid = signedIn() ? String(authUid() || authSession()?.uid || '') : '';
    if (!uid) return [];
    return shop.offers.filter((row) => String(row.sellerUid || '') === uid).map((row) => row.id).filter(Boolean);
  });

  // One book for the desk: the offer bar and the Best Deal rows read this signal.
  const buy = createBuyBook({ cardId, ready: offersReady, language: shownLang });

  /** The Shop row's cart path, so the book rows add listings the same way. */
  function addListingToCart(offer, qty = 1) {
    addToCart({ ...cartItemFromOffer(card(), snapshot(offer)), qty: qty || 1 });
  }

  function chooseDealLang(code) {
    setDealLang(code);
    writeDealLanguage(code, authUser()?.uid);
  }

  /** A Buy offers row is a request for a facet: pick it. A language this printing cannot be listed in stays out. */
  // The sell strip's Sell now: the best open offer for the facet the chips
  // picked when it is not the visitor's own, and Pokoin's starting offer when
  // no buyer has posted one. So there is always something to sell into.
  const sellNowRow = () => {
    const book = buy.book();
    if (!Array.isArray(book)) return null;
    const row = selectionBid(book, { condition: shownCond(), language: shownLang() });
    if (!row) return withHouseOffer(null);
    return buyOfferSellable(row, buy.mine()) ? row : null;
  };
  const sellNowNote = () => {
    const row = sellNowRow();
    if (!row) return '';
    const price = offerPriceLabel(row.best_price_pkn, buyerCurrency(pinnedCurrency()) || 'PKN');
    return row.house
      ? `Pokoin buys ${shownCond()} · ${shownLang()} for ${price}`
      : `Best offer for ${shownCond()} · ${shownLang()} is ${price}`;
  };
  /**
   * What the sell strip's Sell now sells into: this facet's best offer, or
   * Pokoin's starting one with the chips as they stand. The book names nobody,
   * so the dialog is told only what the desk knows: the card and this facet.
   */
  const sellNowTarget = () => sellTarget(sellNowRow(), {
    condition: shownCond(),
    language: shownLang(),
    reverse: dealReverse(),
  });
  /** The desk's own card, as Quick Sell paints it. */
  const sellCard = () => {
    const row = card();
    const ident = printingIdentity(row);
    return {
      name: displayName(row) || row.name || '',
      imageUrl: imageSrc(row, 'grid') || '',
      set: ident.set || '',
      number: ident.number || '',
    };
  };

  function pickOfferCondition(row) {
    if (row?.language) pickDealLang(row.language, true);
    if (row?.condition) pickDealCond(row.condition);
  }

  function pickDealCond(value) {
    setDealCond(value);
    setCondPinned(true);
    setCondAny(false);
  }

  /** `remember` writes the language as the visitor's preference, as a chip press does. */
  function pickDealLang(code, remember = false) {
    setDealLang(code);
    setLangPinned(true);
    setLangAny(false);
    if (remember) writeDealLanguage(code, authUser()?.uid);
  }

  /** See all: the Shop panel is the desk's own last row, and it starts closed. */
  function scrollShop() {
    const open = !shopOpen();
    setShopOpen(open);
    if (!open) return;
    // The Vault is a .shop-panel too: the listings live in the Shop terminal one.
    const panel = document.querySelector('.card-desk .shop-terminal');
    panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    panel?.querySelector('.shop-header')?.focus();
  }

  async function cancelMine(ids) {
    const listingIds = (ids || []).filter(Boolean);
    if (!listingIds.length || listingBusy()) return;
    const noun = listingIds.length === 1 ? 'this listing' : `${listingIds.length} listings`;
    if (!window.confirm(`Remove ${noun} from the shop?`)) return;
    setListingBusy(true);
    setShopError('');
    try {
      const token = await getBearer();
      if (!token) {
        navigate(authFrom(location.pathname || '/marketplace'));
        return;
      }
      const uid = authUser()?.uid || authSession()?.uid;
      await Promise.all(listingIds.map((id) => cancelListing(id, token, uid)));
      listingIds.forEach((id) => dropListing(cardId, id));
      setOffers(omitListings({ offers: snapshot(shop.offers) }, listingIds).offers);
      setEditingOffer((current) => (current && listingIds.includes(current.id) ? null : current));
    } catch (err) {
      if (err.status === 401) {
        navigate(authFrom(location.pathname || '/marketplace'));
        return;
      }
      setShopError(err.message || 'Could not cancel the listing.');
    } finally {
      setListingBusy(false);
    }
  }

  function onListed(created) {
    listingsSeq += 1;
    const seq = listingsSeq;
    const id = card().id;
    invalidateListings(id);
    rememberCreatedListing(id, created);
    setOffers(mergeCreatedListing({ offers: snapshot(shop.offers) }, created).offers);
    setOffersReady(true);
    setEditingOffer(null);
    refreshListings(seq).catch(() => {});
  }

  async function share() {
    const row = card();
    const url = `${window.location.origin}${publicCardPath()}`;
    track(Action.share, row);
    if (canUseNativeShare()) {
      try {
        await navigator.share({ title: displayName(row) || 'Pokoin', text: displayName(row) || '', url });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    try {
      await copyText(url);
      setCopied(true);
      window.clearTimeout(copiedTimer);
      copiedTimer = window.setTimeout(() => setCopied(false), 2000);
    } catch (_) {
      setCopied(false);
    }
  }

  function onWatch() {
    const row = card();
    const on = toggleWatchlist(row.id);
    setWatched(on);
    postWatchlist(row.id, on ? 'add' : 'remove');
    track(Action.watchlist, row, { type: on ? 'watchlist_add' : 'watchlist_remove' });
  }

  function goVersion(event) {
    const value = event.currentTarget.value;
    const row = versionRows().find((item) => String(item.id) === value);
    if (!row || String(row.id) === String(card().id)) return;
    track(Action.clickVersion, row);
    handOffCard(row);
    afterPaint(() => navigate(cardHref(row)));
  }

  function openZoom() {
    setZoom(true);
    track(Action.zoomArt, card());
  }

  function warm(row) {
    handOffCard(row);
    warmupCard(row, { lang, listings: true });
  }

  function addToCart(item) {
    addCartItem(item);
  }

  const setLogo = () => expansionLogoSrc({ slug: setSlug(setName()), name: setName() });

  const skeleton = () => (
    <article class="card-page flutter-page" aria-busy="true">
      <header class="asset-header">
        <div class="asset-title-row">
          <h1><span class="skel-line skel-title" /></h1>
        </div>
        <div class="asset-sub-row">
          <p class="asset-sub"><span class="skel-line skel-line-sm" /></p>
        </div>
      </header>
      <div class="card-desk">
        <div class="hero-art-col">
          <section class="panel art-panel">
            <span class="tile-ph" />
          </section>
        </div>
      </div>
    </article>
  );

  return (
    <Switch>
      <Match when={error() && !page()?.card}>
        <div class={ownerChoices().length ? 'status owner-games' : 'status error'}>
          <Show when={ownerChoices().length} fallback={<p>We couldn't find this card. <a href={gameHref('/marketplace/search')}>Search cards</a></p>}>
            <p>Card #{cardId} exists in several games. Which one did you mean?</p>
            <ul>
              <For each={ownerChoices()}>
                {(choice) => (
                  <li>
                    <a href={choice.href}>{choice.name || `Card #${cardId}`}</a>
                    <span>{[choice.gameName, choice.set].filter(Boolean).join(' · ')}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <a href={gameHref('/marketplace')}>Back to marketplace</a>
        </div>
      </Match>
      <Match when={!page()?.card && !stubCard()}>{skeleton()}</Match>
      <Match when>
        <article class="card-page flutter-page">
          <CardSelectGrid class="card-desk-select" contents>
            <SeoHead
              title={cardDocumentTitle(card())}
              description={cardSeoDescription(card())}
              canonical={publicCardPath()}
              image={art()}
              imageAlt={cardImageAlt(card())}
              jsonLd={jsonLd()}
            />
            <header
              class={!rarityKind() && (pageTheme() || heroShade()) ? 'asset-header shaded' : 'asset-header'}
              style={rarityKind() ? undefined : cardShadeStyle(card())}
            >
              <div class="asset-title-row">
                <h1>
                  <span
                    class="species-drag"
                    draggable="true"
                    title="Drag to add every printing of this Pokémon"
                    onPointerDown={() => preloadDragImage(art())}
                    onDragStart={(event) => {
                      event.stopPropagation();
                      writeListingDrag(event, bundleReference({
                        kind: 'species',
                        slug: species()?.name || displayName(card()),
                        name: species()?.name || displayName(card()),
                        imageUrl: art(),
                        path: species() ? speciesHref() : cardPath(),
                      }));
                    }}
                  >{displayName(card())}</span>
                  <Show when={identityEmoji()}><span class="asset-emoji"> {identityEmoji()}</span></Show>
                </h1>
                <div class="asset-title-tools">
                  <button
                    type="button"
                    class={watched() ? 'icon-btn on' : 'icon-btn'}
                    onClick={onWatch}
                    title={watched() ? 'Remove from watchlist' : 'Add to watchlist'}
                  >
                    {watched() ? '♥' : '♡'}
                  </button>
                  <button
                    type="button"
                    class={copied() ? 'icon-btn on' : 'icon-btn'}
                    onClick={share}
                    aria-label={copied() ? 'Copied' : 'Share'}
                    title={copied() ? 'Copied' : 'Share'}
                  >
                    {copied() ? '✓' : '↗'}
                  </button>
                  <Show when={copied()}><span class="share-copied" role="status">Copied</span></Show>
                </div>
              </div>
              <div class="asset-sub-row">
                <p class="asset-sub">
                  <Show when={setName()}>
                    <a
                      href={gameHref(setHref())}
                      draggable="true"
                      onClick={() => track(Action.clickSet, card())}
                      onPointerDown={() => preloadDragImage(setLogo())}
                      onDragStart={(event) => {
                        event.stopPropagation();
                        writeListingDrag(event, bundleReference({
                          kind: 'expansion',
                          slug: setSlug(setName()),
                          name: setName(),
                          imageUrl: setLogo(),
                          path: setHref(),
                        }));
                      }}
                    >{setName()}</a>
                  </Show>
                  <Show when={collector()}>
                    {setName() ? ' ' : ''}
                    {collector()}
                  </Show>
                  <Show when={rarityKind()}>
                    <span class={['rarity-kind', `is-${rarityKind()}`]}>{rarityKindLabel(card())}</span>
                  </Show>
                  <Show when={artist()}>
                    {' · '}
                    <Show when={artistPath()} fallback={<span>{artist()}</span>}>
                      <a
                        href={gameHref(artistPath())}
                        draggable="true"
                        onClick={() => track(Action.clickArtist, card())}
                        onPointerDown={() => preloadDragImage(artistCover())}
                        onDragStart={(event) => {
                          event.stopPropagation();
                          writeListingDrag(event, bundleReference({
                            kind: 'artist',
                            slug: artistSlug(artist()),
                            name: artist(),
                            imageUrl: artistCover(),
                            path: artistPath(),
                          }));
                        }}
                      >{artist()}</a>
                    </Show>
                  </Show>
                </p>
                <div class="asset-quotes">
                  <span class="quote-label">Market price</span>
                  {/* A button, not a hover title: on a phone a tap is the only way to learn what the number is. */}
                  <button
                    type="button"
                    class={pricePending() || lastDayPkn() ? 'quote-pill quote-pkn' : 'quote-pill quote-pkn oos'}
                    title="Median sold price over the last day"
                    aria-expanded={priceHelp() ? 'true' : 'false'}
                    aria-controls="quote-help"
                    onClick={() => setPriceHelp((open) => !open)}
                  >
                    {pricePending() ? ' ' : (salesSeries() == null ? '—' : (lastDayPkn() || '—'))}
                  </button>
                  <span
                    class={change72h().empty ? 'quote-pill oos' : 'quote-pill'}
                    title="Change versus the sold median from 3 days earlier"
                  >
                    {change72h().text}
                  </span>
                </div>
              </div>
              <Show when={priceHelp()}>
                <p id="quote-help" class="quote-help">
                  Market price is the median this card sold for over the last day, not a listing. {pknRateLabel(buyerCurrency(pinnedCurrency()) || 'EUR')}.
                </p>
              </Show>
            </header>

            <Show when={deskPreview}>
              {/* The preview notice is a note on the viewport, not a line in the
                  band: it must never cost the desk a row. */}
              <p class="desk-preview-note" role="status">{BUYSELL_PREVIEW_BANNER}</p>
            </Show>

            <div class="card-desk">
              <div class="hero-art-col">
                <section class="panel art-panel">
                  <div class="art-num-row">
                    <Show
                      when={prevNav()}
                      fallback={<span class="art-nav ghost" aria-hidden="true"><Chevron dir="left" /></span>}
                    >
                      <a
                        class="art-nav"
                        href={gameHref(cardHref(prevNav()))}
                        aria-label="Previous card in set"
                        onPointerEnter={() => warm(prevNav())}
                        onClick={() => {
                          handOffCard(prevNav());
                          track(Action.prevCard, prevNav());
                        }}
                      >
                        <Chevron dir="left" />
                      </a>
                    </Show>
                    <Switch fallback={<span />}>
                      <Match when={versionRows().length > 1}>
                        <select
                          class="collector-badge version-badge"
                          value={String(card().id)}
                          onChange={goVersion}
                          aria-label="Version"
                        >
                          {/* Keyed by card id: a revalidated list of equal rows keeps its options. */}
                          <For each={versionRows()} keyed={(row) => String(row.id)}>
                            {(row) => (
                              <option value={String(row().id)} selected={String(row().id) === String(card().id)}>
                                {versionOptionLabel(row())}
                              </option>
                            )}
                          </For>
                        </select>
                      </Match>
                      <Match when={versionLabel()}>
                        <span class="collector-badge">{versionLabel()}</span>
                      </Match>
                    </Switch>
                    <Show
                      when={nextNav()}
                      fallback={<span class="art-nav ghost" aria-hidden="true"><Chevron dir="right" /></span>}
                    >
                      <a
                        class="art-nav"
                        href={gameHref(cardHref(nextNav()))}
                        aria-label="Next card in set"
                        onPointerEnter={() => warm(nextNav())}
                        onClick={() => {
                          handOffCard(nextNav());
                          track(Action.nextCard, nextNav());
                        }}
                      >
                        <Chevron dir="right" />
                      </a>
                    </Show>
                  </div>
                  <DeskArtFrame
                    card={card()}
                    art={heroArt()}
                    note={reverseOn() ? `${REVERSE_SCAN_LABEL} scan` : ''}
                    offers={shop.offers}
                    onZoom={openZoom}
                  />
                  <Show when={setShortcuts().length || showMoreVersions() || reverseScan()}>
                    <div class="set-link tight version-links">
                      <Show when={setShortcuts().length || reverseScan() || showMoreVersions()}>
                        <div class="version-shortcuts">
                          <For each={setShortcuts()} keyed={(row) => String(row.id)}>
                            {(row) => {
                              const ident = () => printingIdentity(row());
                              const label = () => [ident().set, ident().number].filter(Boolean).join(' ');
                              const mark = () => (
                                <ExpansionMark
                                  setName={ident().set}
                                  number={row().number || row().card_number}
                                  cardId={row().id}
                                  symbolUrl={row().expansionSymbolUrl || row().defaultSymbolUrl}
                                />
                              );
                              return (
                                <Show
                                  when={String(row().id) === String(card().id)}
                                  fallback={(
                                    <a
                                      class="set-shortcut"
                                      href={gameHref(cardHref(row()))}
                                      title={label()}
                                      aria-label={label()}
                                      onPointerEnter={() => warm(row())}
                                      onClick={() => {
                                        handOffCard(row());
                                        track(Action.clickVersion, row());
                                      }}
                                    >
                                      {mark()}
                                    </a>
                                  )}
                                >
                                  <span class="set-shortcut is-on" title={label()} aria-label={label()} aria-current="page">
                                    {mark()}
                                  </span>
                                </Show>
                              );
                            }}
                          </For>
                          <Show when={reverseScan()}>
                            <button
                              type="button"
                              class={['set-shortcut', 'reverse-toggle', { 'is-on': reverseOn() }]}
                              title={reverseOn() ? 'Back to the regular scan' : REVERSE_SCAN_LABEL}
                              aria-label={REVERSE_SCAN_LABEL}
                              aria-pressed={reverseOn() ? 'true' : 'false'}
                              onClick={toggleReverse}
                            >
                              <ReverseSparkles />
                            </button>
                          </Show>
                          {/* More versions is the last circle in the row: a plus, not a text pill under it. */}
                          <Show when={showMoreVersions()}>
                            <a
                              class={['set-shortcut', 'more-versions', 'more-versions-ico', { 'is-solo': !setShortcuts().length && !reverseScan() }]}
                              href={gameHref(versionsHref(card(), lang))}
                              title="More versions"
                              aria-label="More versions"
                            >
                              <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
                                <circle cx="12" cy="12" r="9.6" />
                                <path d="M12 7.6v8.8M7.6 12h8.8" />
                              </svg>
                            </a>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  </Show>
                </section>
              </div>

              <div class="desk-graph">
                <SoldPriceGraph
                  series={graphSeries()}
                  overlays={graphOverlays()}
                  color={graphColor()}
                  dashed={Boolean(currentFacet()?.reverse)}
                  pickedLabel={graphPickedLabel()}
                  onRemoveOverlay={removeGraphPick}
                  hideUnits
                  emptyLabel={graphEmptyLabel()}
                  filters={graphFilters()}
                  chips={salesView().chips}
                  condition={salesCondition()}
                  language={salesLanguage()}
                  reverse={salesReverse()}
                  reverseLabel={game().id === 'pokemon' ? 'Reverse' : 'Foil'}
                  firstEdition={salesFirstEdition()}
                  graded={salesGraded()}
                  linkedLabel={graphScope()}
                  axisFactor={graphAxisFactor()}
                  onCondition={setSalesCondition}
                  onLanguage={setSalesLanguage}
                  onReverse={setSalesReverse}
                  onFirstEdition={setSalesFirstEdition}
                  onGraded={setSalesGraded}
                  formatPrice={(pkn) => buyerFormat(pkn, true, pinnedCurrency())}
                  onPickDay={(day) => {
                    const traits = soldTraitsForGraphDay(salesSlices() || [], salesFilterState(), day);
                    if (!traits) return;
                    // A plotted day moves the chips, and the chips move the graph.
                    if (traits.condition) pickDealCond(traits.condition);
                    if (traits.language) pickDealLang(traits.language);
                    setDealReverse(Boolean(traits.reverse));
                    setSalesFirstEdition(Boolean(traits.firstEdition));
                    setSalesGraded(Boolean(traits.graded));
                  }}
                />
                <NativeSales cardId={cardId} />
              </div>

              <div class="desk-form">
                <ListingForm
                  card={card()}
                  identity={identity()}
                  salesSlices={salesSlices()}
                  fromPath={fromPath()}
                  preferredLanguage={shownLang()}
                  preferredCondition={shownCond()}
                  versions={clipPrintings()}
                  editing={editingOffer()}
                  onCancelEdit={() => setEditingOffer(null)}
                  onListed={onListed}
                  sellNowNote={sellNowNote()}
                  onSellNow={sellNowTarget() ? () => buy.pickSell(sellNowTarget()) : undefined}
                />
              </div>

              <section class="panel add-panel desk-band" aria-label="Best Deal">
                <div class="band-head">
                  <h2 class="shop-label band-title">Best Deal</h2>
                  <SilverHead card={card()} fromPath={fromPath()} />
                </div>
                <div class="band-main">
                  <div class="band-price">
                    {/* Nothing to buy is the dash in the price slot, as it always was: no sentence in its place. */}
                    <Show
                      when={offersReady() && !canBuy()}
                      fallback={(
                        <>
                          <div class={canBuy() ? 'prod-px' : 'prod-px oos'}>
                            <Show when={offersReady() && canBuy()} fallback="—">
                              <PriceStack flip parts={buyerParts(dealPick()?.pricePkn, dealPick()?.sellerAcceptsPkn, pinnedCurrency())} />
                            </Show>
                          </div>
                          <Show when={offersReady() && canBuy()}>
                            {/* The Vault is Pokoin's own stock: no seller line, and never the admin account's name. */}
                            <Show when={!isVaultOffer(dealPick())}>
                              <p class="deal-sold-by">
                                Sold by{' '}
                                <Show
                                  when={sellerHref(dealPick(), lang)}
                                  fallback={<span>{publicListingSellerName(dealPick()) || 'seller'}</span>}
                                >
                                  <a href={gameHref(sellerHref(dealPick(), lang))}>{publicListingSellerName(dealPick()) || 'seller'}</a>
                                </Show>
                              </p>
                            </Show>
                          </Show>
                        </>
                      )}
                    >
                      {/* The same dash whether nobody sells the card at all or only not this pick; the hover text says which. */}
                      <div
                        class="prod-px oos"
                        title={nativeLive().length
                          ? `No ${pickedLabel()}${dealReverse() ? ' reverse' : ''} listing right now`
                          : 'No Pokoin seller has this card right now'}
                      >
                        —
                      </div>
                    </Show>
                  </div>
                  <div class="deal-facets">
                    <div class="deal-facet-row" role="radiogroup" aria-label="Condition">
                      <For each={DEAL_CONDS}>
                        {(row) => {
                          const listedHere = () => listedCondSet().has(row.value);
                          const on = () => pickedCond() === row.value;
                          // Every grade can be pressed: it also picks what the graph plots.
                          const dim = () => offersReady() && !listedHere();
                          return (
                            <button
                              type="button"
                              role="radio"
                              class={['deal-chip', { 'is-on': on(), 'is-off': dim() }]}
                              aria-checked={on() ? 'true' : 'false'}
                              aria-label={row.label}
                              title={on() ? `${row.label} · press again for any condition` : (listedHere() ? row.label : `${row.label} · none listed`)}
                              onClick={() => (on() ? setCondAny(true) : pickDealCond(row.value))}
                            >
                              <img class="shop-cond" src={conditionChipSrc(row.value)} alt="" width="40" height="28" draggable="false" />
                            </button>
                          );
                        }}
                      </For>
                    </div>
                    <Show when={allDealLangs().length}>
                      <div class="deal-facet-row" role="radiogroup" aria-label="Language">
                        <For each={allDealLangs()}>
                          {(code) => {
                            const listedHere = () => listedLangSet().has(code);
                            const on = () => pickedLang() === code;
                            const dim = () => offersReady() && !listedHere();
                            return (
                              <button
                                type="button"
                                role="radio"
                                class={['deal-chip', { 'is-on': on(), 'is-off': dim() }]}
                                aria-checked={on() ? 'true' : 'false'}
                                aria-label={code}
                                title={on() ? `${code} · press again for any language` : (listedHere() ? code : `${code} · none listed`)}
                                onClick={() => (on() ? setLangAny(true) : pickDealLang(code, true))}
                              >
                                <img class="deal-flag" src={flagSrc(code)} alt="" width="22" height="22" />
                                <span>{code}</span>
                              </button>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                    <Show when={showReverseChip()}>
                      <div class="deal-facet-row" role="group" aria-label="Finish">
                        <button
                          type="button"
                          class={['deal-chip', 'deal-chip-reverse', { 'is-on': dealReverse() }]}
                          aria-pressed={dealReverse() ? 'true' : 'false'}
                          title={dealReverse() ? 'Showing reverse only' : 'Show reverse only'}
                          onClick={() => setDealReverse(!dealReverse())}
                        >
                          <ReverseSparkles />
                          <span>{game().id === 'pokemon' ? 'Reverse' : 'Foil'}</span>
                        </button>
                      </div>
                    </Show>
                  </div>
                  <div class="band-actions">
                    <OfferBar
                      buy={buy}
                      card={card()}
                      cardId={cardId}
                      above={canBuy()}
                      condition={shownCond()}
                      language={shownLang()}
                      languages={allDealLangs()}
                      pinned={pinnedCurrency()}
                      askFor={(cond, lang) => matchDeal(nativeLive(), lang, cond, card())?.pricePkn}
                      onBuyNow={() => document.querySelector('.desk-band .buy-btn')?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
                    />
                    {/* With nothing to buy the price slot already says so: no dead button beside it. */}
                    <Show when={!offersReady() || canBuy()}>
                      <Show
                        when={canBuy()}
                        fallback={<span class="btn ghost buy-btn" aria-hidden="true">Add to cart</span>}
                      >
                        <button
                          class="btn buy-btn"
                          type="button"
                          onClick={() => {
                            const row = card();
                            track(Action.buyIntent, row);
                            addToCart(cartItemFromOffer(row, snapshot(dealPick())));
                            navigate('/cart');
                          }}
                        >
                          Add to cart
                        </button>
                      </Show>
                    </Show>
                  </div>
                </div>
              </section>

              <CheapestListings
                rows={nativeLive()}
                card={card()}
                ready={offersReady()}
                marketPrice={salesSeries()?.lastMedianPkn}
                max={deskRows()}
                open={shopOpen()}
                mineIds={mineIds()}
                listingBusy={listingBusy()}
                onCart={addListingToCart}
                onInspect={openZoom}
                onEdit={(offer) => setEditingOffer(editingOffer()?.id === offer.id ? null : snapshot(offer))}
                onCancel={(offer) => cancelMine([offer.id])}
                onSeeAll={scrollShop}
              />
              <BuyOffers
                buy={buy}
                condition={shownCond()}
                language={shownLang()}
                pinned={pinnedCurrency()}
                max={deskRows()}
                onCondition={pickOfferCondition}
              />

              {/* Pokoin's own stock gets its own row, and only when there is some:
                  an empty Vault is not a panel, at any width. */}
              <Show when={split().vault.length}>
                <section class="panel shop-panel vault-panel">
                  <header class="panel-head shop-head">
                    <h2 class="shop-label vault-title">
                      <Ico name="vault" />
                      <span>Vault</span>
                    </h2>
                  </header>
                  <ShopList offers={split().vault} deskCard={card()}>
                    <For each={split().vault}>
                      {(offer) => (
                        <ShopListingRow
                          offer={offer}
                          anonymous
                          card={card()}
                          mine={mineIds().includes(offer.id)}
                          selected={listingSelected().has(listingSelectId(offer))}
                          dragOffers={shopDragOffers(split().vault, listingSelected(), offer)}
                          listingBusy={listingBusy()}
                          editing={editingOffer()?.id === offer.id}
                          onCart={(qty) => addListingToCart(offer, qty)}
                          onInspect={openZoom}
                          onEdit={() => setEditingOffer(editingOffer()?.id === offer.id ? null : snapshot(offer))}
                          onCancel={() => cancelMine([offer.id])}
                        />
                      )}
                    </For>
                  </ShopList>
                </section>
              </Show>
              {/* See all opens the full Shop in place, as the desk's last row. */}
              <Show when={shopOpen()}>
                <section class="panel shop-panel shop-terminal" aria-label="Shop">
                  <h2 class="sr-only">Shop</h2>
                  <Show when={split().shop.length || condition() || language()}>
                    <ShopHeader
                      condition={condition()}
                      language={language()}
                      languages={languages()}
                      sort={offerSort()}
                      onCondition={setCondition}
                      onLanguage={setLanguage}
                      onSort={setOfferSort}
                    />
                  </Show>
                  <Show when={shopError()}><p class="sell-msg error">{shopError()}</p></Show>
                  <Show
                    when={split().shop.length}
                    fallback={(
                      <div class="empty-shop">
                        <Show when={offersReady()} fallback={<p class="status"> </p>}>
                          <Show
                            when={condition() || language()}
                            fallback={(
                              <>
                                <p class="status">No Pokoin listings for this card yet.</p>
                                <Show when={salesSeries()?.lastMedianPkn}>
                                  <p class="status muted">The market price above is what it recently sold for, not an offer.</p>
                                </Show>
                              </>
                            )}
                          >
                            <p class="status">
                              No listings match these filters.{' '}
                              <button
                                type="button"
                                class="shop-clear"
                                onClick={() => { setCondition(''); setLanguage(''); }}
                              >
                                Clear filters
                              </button>
                            </p>
                          </Show>
                        </Show>
                      </div>
                    )}
                  >
                    <ShopList offers={split().shop} deskCard={card()}>
                      <For each={split().shop}>
                        {(offer) => (
                          <ShopListingRow
                            offer={offer}
                            card={card()}
                            mine={mineIds().includes(offer.id)}
                            selected={listingSelected().has(listingSelectId(offer))}
                            dragOffers={shopDragOffers(split().shop, listingSelected(), offer)}
                            listingBusy={listingBusy()}
                            editing={editingOffer()?.id === offer.id}
                            onCart={(qty) => addListingToCart(offer, qty)}
                            onInspect={openZoom}
                            onEdit={() => setEditingOffer(editingOffer()?.id === offer.id ? null : snapshot(offer))}
                            onCancel={() => cancelMine([offer.id])}
                          />
                        )}
                      </For>
                    </ShopList>
                  </Show>
                </section>
              </Show>
            </div>

            <Show when={later()}>
              <RelatedCards
                card={card()}
                related={related()}
                speciesName={species()?.name}
                speciesHref={speciesHref()}
                embedded
              />
              <details class="catalog-fold">
                <summary>More in the catalog</summary>
                <SeoCrumbs items={seoCrumbs()} />
                <Show when={relatedHubs().length}>
                  <p class="related-hubs">
                    <For each={relatedHubs()}>
                      {(hub, index) => (
                        <span>
                          {index() ? ' · ' : ''}
                          <a href={gameHref(hub.href)}>{hub.name}</a>
                        </span>
                      )}
                    </For>
                  </p>
                </Show>
              </details>
            </Show>

            {/* Quick Sell: what every Sell press on this desk opens. `keyed` because
                each intent is a new target, so the same row twice is a fresh dialog. */}
            <Show when={buy.sellPick()} keyed>
              {(pick) => (
                <QuickSellDialog
                  target={pick()}
                  cardId={cardId}
                  card={sellCard()}
                  pinned={pinnedCurrency()}
                  preview={buy.preview}
                  fromPath={fromPath()}
                  onClose={buy.closeSell}
                  onDone={() => buy.reload()}
                />
              )}
            </Show>

            <Show when={zoom()}>
              <dialog
                ref={(el) => { zoomEl = el; }}
                class={['zoom', { 'is-landscape': isLandscapeDesk(card()) }]}
                onClose={() => setZoom(false)}
                onClick={(event) => {
                  if (event.target === zoomEl) setZoom(false);
                }}
              >
                <Show when={heroArt()}>
                  <CardArt
                    src={heroArt()}
                    langScans={reverseOn() || isLandscapeDesk(card()) ? undefined : card().langScans}
                    alt={cardImageAlt(card())}
                    full
                    dragCard={dragThisCard(card(), shop.offers)}
                    onClick={() => setZoom(false)}
                  />
                </Show>
              </dialog>
            </Show>
          </CardSelectGrid>
        </article>
      </Match>
    </Switch>
  );
}
