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
import { useLocation, useNavigate, useParams } from '@solidjs/router';
import {
  artistHref,
  artistSlug,
  cancelListing,
  cardFromCatalogRow,
  cardHref,
  dropListing,
  fetchArtistSummaries,
  fetchCanonicalPath,
  fetchCard,
  fetchCardSales,
  fetchExactNameCards,
  fetchListings,
  fetchPrintNationality,
  fetchVersionSet,
  imageSrc,
  invalidateListings,
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
import { cartItemFromOffer } from '@market/cart-rows.js';
import { bundleReference, preloadDragImage, writeListingDrag } from '@market/chat-listing.js';
import { resolveDealLanguage, writeDealLanguage } from '@market/deal-pref.js';
import { game, publicGamePath } from '@market/game.js';
import { cardDocumentTitle, displayName, printingIdentity } from '@market/identity.js';
import { sellLanguages } from '@market/listing-languages.js';
import { applyListingLive, subscribeListingLive } from '@market/listing-live.js';
import { conditionChipSrc, publicListingSellerName, sellerHref } from '@market/listing-meta.js';
import { flagSrc, languagesForNationality } from '@market/locale.js';
import { currencyFromSearch } from '@market/pkn.js';
import { pokemonHref, speciesFromCard } from '@market/pokemon-hubs.js';
import { clearActiveDeskCard, setActiveDeskCard } from '@market/poko-chat.js';
import { authFrom } from '@market/punchouts.js';
import { rarityKindLabel, storedRarityKind } from '@market/rarity-theme.js';
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
import { shopDragOffers } from '@market/shop-marquee.js';
import { peekCardSales, rememberStaleCardSales, saveCardSales } from '@market/sold-sales-cache.js';
import { soldGraphView, soldTraitsForGraphDay } from '@market/sold-sales.js';
import { Action, track } from '@market/track.js';
import CardArt from '../components/CardArt.jsx';
import CardSelectGrid from '../components/CardSelectGrid.jsx';
import DeskArtFrame, { Chevron, dragThisCard, isLandscapeDesk } from '../components/desk/DeskArtFrame.jsx';
import ListingForm from '../components/desk/ListingForm.jsx';
import NativeSales from '../components/desk/NativeSales.jsx';
import RelatedCards from '../components/desk/RelatedCards.jsx';
import SeoCrumbs from '../components/desk/SeoCrumbs.jsx';
import ShopListingRow, { ShopList } from '../components/desk/ShopListing.jsx';
import SilverHead from '../components/desk/SilverHead.jsx';
import SoldPriceGraph from '../components/desk/SoldPriceGraph.jsx';
import ExpansionMark from '../components/ExpansionMark.jsx';
import PriceStack from '../components/PriceStack.jsx';
import SeoHead from '../components/SeoHead.jsx';
import { handOffCard, peekHandoffCard } from '../lib/card-handoff.js';
import { authUser, getBearer } from '../stores/auth.js';
import { buyerFormat, buyerParts, buyerPending, sellerSettings } from '../stores/buyer.js';
import { addCartItem } from '../stores/cart.js';
import { authSession } from '../stores/session.js';
import { afterPaint } from '../lib/yield-nav.js';

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
 * Card desk route (market/src/pages/Card.jsx). One desk per `lang:cardId`:
 * ‹ › and the version select remount it, which resets the per-card state the
 * React page resets by hand. The theme and the Poko desk card are cleared only
 * when the route itself unmounts, so a neighbour step never flashes untinted.
 */
export default function Card() {
  const params = useParams();
  const location = useLocation();
  const navigate = useNavigate();
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
  const navigate = useNavigate();
  const pinnedCurrency = () => currencyFromSearch(location.search);

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
  const firstStub = untrack(stubCard);
  const [page, setPage] = createSignal(
    cached
      ? { ...cached, neighbors: neighborsOrPeek(cardId, cached.neighbors) }
      : (firstStub ? { card: firstStub, versions: [], neighbors: neighborsOrPeek(cardId) } : null),
  );
  const [shop, setShop] = createStore({
    offers: offerCopies(peekHasListingRows(listed) ? listed.listings : (cached?.offers || [])),
  });
  const [offersReady, setOffersReady] = createSignal(peekHasListingRows(listed));
  const [error, setError] = createSignal('');
  const [zoom, setZoom] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [watched, setWatched] = createSignal(readWatchlistIds().includes(cardId));
  const [offerSort, setOfferSort] = createSignal('price');
  const [condition, setCondition] = createSignal('');
  const [language, setLanguage] = createSignal('');
  const [dealLang, setDealLang] = createSignal('');
  const [dealCond, setDealCond] = createSignal('');
  const [listingBusy, setListingBusy] = createSignal(false);
  const [shopError, setShopError] = createSignal('');
  const [editingOffer, setEditingOffer] = createSignal(null);
  const [namePrintings, setNamePrintings] = createSignal(catalogPrintings(cached?.rarities));
  const [artPrintings, setArtPrintings] = createSignal(rowsFrom(cached?.versions));
  const [salesSlices, setSalesSlices] = createSignal(peekCardSales(cardId)?.slices ?? null);
  const [salesCondition, setSalesCondition] = createSignal('');
  const [salesLanguage, setSalesLanguage] = createSignal('');
  const [salesReverse, setSalesReverse] = createSignal(false);
  const [salesFirstEdition, setSalesFirstEdition] = createSignal(false);
  const [salesGraded, setSalesGraded] = createSignal(false);
  const [setNationality, setSetNationality] = createSignal('');
  const [artistCover, setArtistCover] = createSignal('');
  let disposed = false;
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
  function refreshListings(seq) {
    return fetchListings(cardId, { fresh: true }).then((list) => {
      if (disposed || seq !== listingsSeq) return;
      const rows = list.listings || [];
      if (rows.length || !shop.offers.length) setOffers(rows);
      setOffersReady(true);
    });
  }

  function replaceToCanonical(path) {
    const next = canonicalTarget(path, untrack(() => location.pathname));
    if (next) navigate(next, { replace: true, scroll: false });
  }

  function showCard(data) {
    if (disposed || !data?.card) return;
    const neighborWindow = neighborsOrPeek(cardId, data.neighbors);
    warmupNeighbors(neighborWindow, { lang });
    const current = untrack(page);
    const { offers: _pageOffers, ...rest } = data;
    const merged = mergeDeskCard(current?.card, data.card);
    rememberCardId(merged);
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
    track(Action.viewCard, card);
    if (card.canonicalPath) replaceToCanonical(card.canonicalPath);
  }

  // Network starts with the component, not after the first paint.
  listingsSeq += 1;
  refreshListings(listingsSeq).catch(() => {
    if (!disposed) setOffersReady(true);
  });
  fetchCard(cardId, { lang, slug: untrack(() => props.slug || ''), includeOffers: false, fresh: Boolean(cached) })
    .then(showCard)
    .catch((err) => {
      if (disposed) return;
      if (err.status === 404) {
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
  fetchVersionSet(cardId).then((data) => {
    if (disposed) return;
    const rows = rowsFrom(data?.printings);
    if (rows.length) setArtPrintings(rows);
  }).catch(() => {
    /* Keep marketplace-card-page `versions` so 2–6 reprints still paint. */
  });
  if (cached) rememberNeighbors(cached.card, cached.neighbors);
  // Arrows painted from the cache: warm the next hop now, not after this
  // card's own page loads, so fast clicking keeps finding neighbours.
  if (!cached) {
    const painted = untrack(page)?.neighbors;
    if (painted?.prev?.length || painted?.next?.length) warmupNeighbors(painted, { lang });
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
  const art = createMemo(() => imageSrc(card(), 'hero'));
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
  const shownLang = createMemo(() => resolveDealLanguage({
    selected: dealLang() || 'EN',
    listed: offersReady() ? listedDealLangs() : [],
    country: sellerSettings()?.shipFromCountry,
  }));
  // The chosen grade when it is listed in the shown language, else the best one that is.
  const shownCond = createMemo(() => {
    const wanted = dealCond() || 'NM';
    return offersReady() ? shownDealCondition(nativeLive(), shownLang(), wanted, card()) : wanted;
  });
  const dealPick = createMemo(() => (offersReady() ? matchDeal(nativeLive(), shownLang(), shownCond(), card()) : null));
  const lastDayPkn = () => buyerFormat(salesSeries()?.lastMedianPkn, true, pinnedCurrency());
  const pricePending = () => !pinnedCurrency() && buyerPending();
  const change72h = () => formatChange72h(salesSeries()?.change24hPct);
  const canBuy = () => Boolean(dealPick());
  const listedCondSet = createMemo(() => new Set(listedDealConditions(nativeLive(), shownLang(), card()).map((row) => row.value)));
  const listedLangSet = createMemo(() => new Set(listedDealLangs()));
  const allDealLangs = createMemo(() => {
    const row = card();
    const all = [...sellLanguages({
      nationality: row.nationality,
      setName: identity().set || row.set,
      releaseLanguages: row.releaseLanguages,
    })];
    for (const code of [...listedDealLangs(), shownLang()]) {
      if (code && !all.includes(code)) all.push(code);
    }
    return all;
  });
  const languages = createMemo(() => languagesForNationality(
    card().nationality,
    [...new Set(shop.offers.map((row) => String(row.language || '').toUpperCase()).filter(Boolean))],
  ));
  const collector = () => identity().number || '';
  const versionRows = createMemo(() => rarityVersions(card(), namePrintings()));
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
  const related = createMemo(() => pickRelatedCards(card(), [
    clipPrintings(),
    namePrintings(),
    neighborWindow().prev,
    neighborWindow().next,
  ], 12));
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
  const mineIds = createMemo(() => {
    const uid = String(authUser()?.uid || '');
    if (!uid) return [];
    return shop.offers.filter((row) => String(row.sellerUid || '') === uid).map((row) => row.id).filter(Boolean);
  });

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
        <div class="status error">
          <p>Card market not found.</p>
          <a href="/marketplace">Back to marketplace</a>
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
                      href={setHref()}
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
                        href={artistPath()}
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
                  <span
                    class={pricePending() || lastDayPkn() ? 'quote-pill quote-pkn' : 'quote-pill quote-pkn oos'}
                    title="Last day's median inferred sold price"
                  >
                    {pricePending() ? ' ' : (salesSeries() == null ? '—' : (lastDayPkn() || '—'))}
                  </span>
                  <span
                    class={change72h().empty ? 'quote-pill oos' : 'quote-pill'}
                    title="Change versus the sold median from 3 days earlier"
                  >
                    {change72h().text}
                  </span>
                </div>
              </div>
            </header>

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
                        href={cardHref(prevNav())}
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
                          <For each={versionRows()}>
                            {(row) => (
                              <option value={String(row.id)} selected={String(row.id) === String(card().id)}>
                                {versionOptionLabel(row)}
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
                        href={cardHref(nextNav())}
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
                  <DeskArtFrame card={card()} art={art()} offers={shop.offers} onZoom={openZoom} />
                  <Show when={setShortcuts().length || showMoreVersions()}>
                    <div class="set-link tight version-links">
                      <Show when={setShortcuts().length}>
                        <div class="version-shortcuts">
                          <For each={setShortcuts()}>
                            {(row) => {
                              const ident = printingIdentity(row);
                              const label = [ident.set, ident.number].filter(Boolean).join(' ');
                              const mark = () => (
                                <ExpansionMark setName={ident.set} symbolUrl={row.expansionSymbolUrl || row.defaultSymbolUrl} />
                              );
                              return (
                                <Show
                                  when={String(row.id) === String(card().id)}
                                  fallback={(
                                    <a
                                      class="set-shortcut"
                                      href={cardHref(row)}
                                      title={label}
                                      aria-label={label}
                                      onPointerEnter={() => warm(row)}
                                      onClick={() => {
                                        handOffCard(row);
                                        track(Action.clickVersion, row);
                                      }}
                                    >
                                      {mark()}
                                    </a>
                                  )}
                                >
                                  <span class="set-shortcut is-on" title={label} aria-label={label} aria-current="page">
                                    {mark()}
                                  </span>
                                </Show>
                              );
                            }}
                          </For>
                        </div>
                      </Show>
                      <Show when={showMoreVersions()}>
                        <a class={['more-versions', { 'is-solo': !setShortcuts().length }]} href={versionsHref(card(), lang)}>
                          More versions...
                        </a>
                      </Show>
                    </div>
                  </Show>
                </section>
              </div>

              <div class="hero-center">
                <SoldPriceGraph
                  series={salesSeries()}
                  filters={graphFilters()}
                  chips={salesView().chips}
                  condition={salesCondition()}
                  language={salesLanguage()}
                  reverse={salesReverse()}
                  firstEdition={salesFirstEdition()}
                  graded={salesGraded()}
                  onCondition={setSalesCondition}
                  onLanguage={setSalesLanguage}
                  onReverse={setSalesReverse}
                  onFirstEdition={setSalesFirstEdition}
                  onGraded={setSalesGraded}
                  formatPrice={(pkn) => buyerFormat(pkn, true, pinnedCurrency())}
                  onPickDay={(day) => {
                    const traits = soldTraitsForGraphDay(salesSlices() || [], salesFilterState(), day);
                    if (!traits) return;
                    setSalesCondition(traits.condition);
                    setSalesLanguage(traits.language);
                    setSalesReverse(Boolean(traits.reverse));
                    setSalesFirstEdition(Boolean(traits.firstEdition));
                    setSalesGraded(Boolean(traits.graded));
                  }}
                />
                <NativeSales cardId={cardId} />
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
                />
              </div>

              <div class="hero-deal">
                <section class="panel add-panel">
                  <div class="add-head">
                    <h2>Best Deal</h2>
                    <SilverHead card={card()} fromPath={fromPath()} />
                  </div>
                  <div class={canBuy() ? 'prod-px' : 'prod-px oos'}>
                    <Show when={offersReady() && canBuy()} fallback="—">
                      <PriceStack parts={buyerParts(dealPick()?.pricePkn, dealPick()?.sellerAcceptsPkn, pinnedCurrency())} />
                    </Show>
                  </div>
                  <Show when={offersReady() && canBuy()}>
                    <p class="deal-sold-by">
                      Sold by{' '}
                      <Show
                        when={sellerHref(dealPick(), lang)}
                        fallback={<span>{publicListingSellerName(dealPick()) || 'seller'}</span>}
                      >
                        <a href={sellerHref(dealPick(), lang)}>{publicListingSellerName(dealPick()) || 'seller'}</a>
                      </Show>
                    </p>
                  </Show>
                  <div class="deal-facets">
                    <div class="deal-facet-row" role="radiogroup" aria-label="Condition">
                      <For each={DEAL_CONDS}>
                        {(row) => {
                          const listedHere = () => listedCondSet().has(row.value);
                          const on = () => shownCond() === row.value;
                          const ring = () => offersReady() && on() && canBuy();
                          const dim = () => offersReady() && (on() ? !canBuy() : !listedHere());
                          return (
                            <button
                              type="button"
                              role="radio"
                              class={['deal-chip', { 'is-on': ring(), 'is-off': dim() }]}
                              aria-checked={on() ? 'true' : 'false'}
                              aria-label={row.label}
                              title={listedHere() && (!on() || canBuy()) ? row.label : `${row.label} · none listed`}
                              disabled={dim()}
                              onClick={() => setDealCond(row.value)}
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
                            const on = () => shownLang() === code;
                            const ring = () => offersReady() && on() && canBuy();
                            const dim = () => offersReady() && (on() ? !canBuy() : !listedHere());
                            return (
                              <button
                                type="button"
                                role="radio"
                                class={['deal-chip', { 'is-on': ring(), 'is-off': dim() }]}
                                aria-checked={on() ? 'true' : 'false'}
                                aria-label={code}
                                title={listedHere() && (!on() || canBuy()) ? code : `${code} · none listed`}
                                disabled={dim()}
                                onClick={() => {
                                  setDealLang(code);
                                  writeDealLanguage(code, authUser()?.uid);
                                }}
                              >
                                <img class="deal-flag" src={flagSrc(code)} alt="" width="22" height="22" />
                                <span>{code}</span>
                              </button>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                  <Show when={canBuy()} fallback={<span class="btn ghost buy-btn">Unavailable</span>}>
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
                </section>
              </div>

              <section class="panel shop-panel shop-terminal">
                <header class="panel-head shop-head">
                  <h2>Shop</h2>
                  <Show when={shop.offers.length}>
                    <div class="shop-tools">
                      <label class="sort">
                        Condition
                        <select value={condition()} onChange={(event) => setCondition(event.currentTarget.value)}>
                          <For each={CONDITIONS}>
                            {(row) => <option value={row.value} selected={row.value === condition()}>{row.label}</option>}
                          </For>
                        </select>
                      </label>
                      <Show when={languages().length}>
                        <label class="sort">
                          Language
                          <select value={language()} onChange={(event) => setLanguage(event.currentTarget.value)}>
                            <option value="" selected={!language()}>Any</option>
                            <For each={languages()}>
                              {(code) => <option value={code} selected={code === language()}>{code}</option>}
                            </For>
                          </select>
                        </label>
                      </Show>
                      <label class="sort">
                        Sort
                        <select value={offerSort()} onChange={(event) => setOfferSort(event.currentTarget.value)}>
                          <option value="price" selected={offerSort() === 'price'}>Lowest price</option>
                          <option value="price-desc" selected={offerSort() === 'price-desc'}>Highest price</option>
                          <option value="qty" selected={offerSort() === 'qty'}>Most quantity</option>
                          <option value="seller" selected={offerSort() === 'seller'}>Seller</option>
                        </select>
                      </label>
                    </div>
                  </Show>
                </header>
                <Show when={shopError()}><p class="sell-msg error">{shopError()}</p></Show>
                <Show
                  when={offers().length}
                  fallback={(
                    <div class="empty-shop">
                      <p class="status">{offersReady() ? 'No items found' : ' '}</p>
                    </div>
                  )}
                >
                  <ShopList>
                    <For each={offers()}>
                      {(offer) => (
                        <ShopListingRow
                          offer={offer}
                          card={card()}
                          mine={mineIds().includes(offer.id)}
                          selected={false}
                          dragOffers={shopDragOffers(offers(), new Set(), offer)}
                          listingBusy={listingBusy()}
                          editing={editingOffer()?.id === offer.id}
                          onCart={(qty) => addToCart({ ...cartItemFromOffer(card(), snapshot(offer)), qty: qty || 1 })}
                          onInspect={openZoom}
                          onEdit={() => setEditingOffer(editingOffer()?.id === offer.id ? null : snapshot(offer))}
                          onCancel={() => cancelMine([offer.id])}
                        />
                      )}
                    </For>
                  </ShopList>
                </Show>
              </section>
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
                          <a href={hub.href}>{hub.name}</a>
                        </span>
                      )}
                    </For>
                  </p>
                </Show>
              </details>
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
                <Show when={art()}>
                  <CardArt
                    src={art()}
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
