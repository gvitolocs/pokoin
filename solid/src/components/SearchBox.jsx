import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from 'solid-js';
import { Portal } from '@solidjs/web';
import { useLocation } from '@solidjs/router';
import { useGameNavigate } from '../lib/game-navigate.js';
import {
  cardFromAutocomplete,
  cardHref,
  fetchArtist,
  fetchExpansionCards,
  fetchNamePrintings,
  fetchSearch,
  fetchSellerSearchWithAssociates,
  fetchSuggest,
  imageSrc,
  warmupCard,
} from '@market/api.js';
import { resolveArtLayout } from '@market/art-cut.js';
import {
  albumShade,
  deskTheme,
  rememberCardBucket,
  rememberDeskIdentity,
  subscribeShadeBuckets,
  warmCardBucket,
} from '@market/art-shade.js';
import { associateRoleLabel } from '@market/associate-roles.js';
import { compactQuery } from '@market/compact-query.js';
import { isPokemonGame, stripGamePrefix } from '@market/game.js';
import { clipSuggestCollector, printingIdentity, suggestCardName, suggestTranslatedLine } from '@market/identity.js';
import { sellerHref } from '@market/listing-meta.js';
import { flagSrc, printFlagFromNationality, rowPrintBucket } from '@market/locale.js';
import { prefersArtworkDelta, rarityRowTheme } from '@market/rarity-theme.js';
import { cdnFetchUrl, rasterSiblings } from '@market/image-urls.js';
import { prefetchSearchPage, takeHotSearchPage } from '@market/search-hot.js';
import { createPageMemo } from '@market/suggest-page-memo.js';
import { buildInterestProfile, personalPopup, predictInterest, readInterestEvents } from '@market/interest-profile.js';
import { fetchSearchRecall } from '@market/search-recall.js';
import { normalizeSearchTab, printingMatchesSearchTab, searchHref, uniqueSellers } from '@market/search-kind.js';
import { warmupSearchUniverse } from '@market/search-warmup.js';
import { createSuggestFlip } from '@market/suggest-flip.js';
import { SUGGEST_SESSION_CLOSED, nextSuggestSession } from '@market/suggest-hold.js';
import { SUGGEST_REPAINT_MS, createRepaintGate } from '@market/suggest-repaint.js';
import {
  SUGGEST_ROTATE_HEAD,
  SUGGEST_ROTATE_POOL,
  nextRotateState,
  rotateTail,
  suggestRotateEnabled,
} from '@market/suggest-rotate.js';
import { pickSuggestHoverSrc, sameSuggestHoverBox, suggestHoverAllowed, suggestHoverBox } from '@market/suggest-hover.js';
import { SUGGEST_THUMB_EAGER, SUGGEST_THUMB_HIGH, collectPrintingThumbUrls, preloadSuggestThumbs } from '@market/suggest-images.js';
import { fitSuggestTitles } from '@market/suggest-title-fit.js';
import { Action, track } from '@market/track.js';
import { handOffCard } from '../lib/card-handoff.js';
import { printLang, searchLang } from '../stores/locale.js';
import CardArt from './CardArt.jsx';
import ExpansionMark from './ExpansionMark.jsx';
import SearchTabs from './SearchTabs.jsx';
import { GameSelect, LangToggle, PrintLangToggle } from './SearchToggles.jsx';
import { afterPaint as navigateAfterPaint } from '../lib/yield-nav.js';

// ---------------------------------------------------------------------------
// Lazy engine: one chunk (ranker + catalog), loaded on focus or idle.
const [engine, setEngine] = createSignal(null);
let enginePromise = null;

export function loadSuggestEngine() {
  if (!enginePromise) {
    enginePromise = import('../lib/suggest-engine.js').then(
      (module) => {
        setEngine(() => module);
        return module;
      },
      (error) => {
        enginePromise = null;
        throw error;
      },
    );
  }
  return enginePromise;
}

/** Printing pages already fetched for a lookup, shared by every keystroke (suggest-page-memo.js). */
const suggestPage = createPageMemo(fetchSuggest);
/** How long typing must pause before the results-page total is asked for. */
const RESULTS_COUNT_DELAY_MS = 150;

/**
 * Evaluate the engine on search intent (pointer down, focus, first key), after
 * the browser paints that interaction. Its chunks are already in the HTTP
 * cache: index.html prefetches them at idle priority (vite.config.js).
 */
function loadSuggestEngineOnIntent() {
  if (enginePromise) return;
  afterPaint(() => loadSuggestEngine().catch(() => {}));
}

/** Same minimum as suggest-live SUGGEST_LIVE_MIN_CHARS (the popup opens at 3 compact chars). */
const LIVE_MIN_CHARS = 3;
const liveReady = (text) => (engine() ? engine().suggestLiveReady(text) : compactQuery(text).length >= LIVE_MIN_CHARS);

/** ARIA state attributes keep "false" (a bare false would drop the attribute). */
const ariaBool = (value) => (value ? 'true' : 'false');

/** Run `fn` after the browser has painted the current frame. */
function afterPaint(fn) {
  if (typeof requestAnimationFrame !== 'function') return setTimeout(fn, 0);
  return requestAnimationFrame(() => setTimeout(fn, 0));
}

// The same printing object is mapped by flat(), every row memo and the thumb
// effect: map it once. Keys are the objects paintCatalogGroups returned.
const cardCache = new WeakMap();
function cardOf(printing) {
  let card = cardCache.get(printing);
  if (!card) {
    card = cardFromAutocomplete(printing);
    cardCache.set(printing, card);
  }
  return card;
}
const thumbCache = new WeakMap();
function thumbOf(card) {
  let src = thumbCache.get(card);
  if (src === undefined) {
    src = imageSrc(card, 'suggest');
    thumbCache.set(card, src);
  }
  return src;
}

function suggestThumbSrc(printing) {
  const live = engine();
  const card = cardOf(printing);
  if (live && (live.isLiveStub(card) || live.isLiveStub(printing))) return '';
  return thumbOf(card);
}

function flattenSuggestRows(groups) {
  const rows = [];
  const seen = new Set();
  let prevGroup = null;
  (groups || []).forEach((group) => {
    (group.printings || []).forEach((printing) => {
      if (!printing || typeof printing !== 'object') return;
      const card = cardOf(printing);
      if (!card.id) return;
      const key = String(card.id);
      if (seen.has(key)) return;
      seen.add(key);
      const groupName = group.name;
      rows.push({
        key,
        printing,
        card,
        group,
        groupName,
        groupStart: rows.length > 0 && group !== prevGroup,
        optionId: `suggest-${card.id}`,
      });
      prevGroup = group;
    });
  });
  return rows;
}

/**
 * Page every catalogRecall lookup of `text` through `suggestPage`, the way the
 * progressive pool does, remembering each page in the suggest-live cache.
 * `onPage(page, incoming)` runs per page; `alive()` false stops between pages
 * (returns 'stale' when a page landed after that). Shared by the pool and
 * prewarmSuggest, so a warmed query hits exactly the same memo keys.
 */
async function pageUniverse(live, text, { lang, print, signal, alive = () => true, onPage } = {}) {
  for (const lookup of live.catalogRecall(text)) {
    if (!alive()) return 'stopped';
    let offset = 0;
    let chunks = 0;
    let fetched = 0;
    const compactLength = compactQuery(lookup).length;
    while (alive()) {
      const size = live.chunkSize(chunks);
      const page = await suggestPage(lookup, {
        limit: size, offset, progressive: true, hydrate: true, signal, lang, printLang: print,
      });
      if (!alive()) return 'stale';
      live.rememberSuggestGroups(page?.groups, { searchLang: lang });
      const incoming = (page?.groups || []).reduce((sum, group) => sum + (group.printings || []).length, 0);
      onPage?.(page, incoming);
      fetched += incoming;
      chunks += 1;
      offset = Number.isFinite(Number(page?.nextOffset)) ? Number(page.nextOffset) : offset + incoming;
      const exhaustive = page?.exhaustive === true || incoming < size;
      if (exhaustive || incoming === 0) break;
      if (fetched >= live.SAFETY_BUDGET || chunks >= live.MAX_CHUNKS) break;
      // One letter prefetches a page. A real name keeps paging its printings.
      if (compactLength <= 2) break;
    }
  }
  return 'done';
}

/** The name / artist / set catalogs the local resolver points `text` at. */
function catalogTargets(live, text, lang) {
  const targets = [];
  const prefixName = live.earlySetPrefixName(text, { lang });
  if (prefixName) targets.push({ key: `prefix-name:${lang}:${prefixName}`, kind: 'name', name: prefixName });
  const resolved = live.resolveSuggestQuery(text);
  if (resolved?.best) {
    for (const entity of resolved.best.entities.artist) {
      const span = resolved.best.spans?.find((row) => row.candidate?.slug === entity.slug);
      if (entity.slug && compactQuery(span?.raw || '').length >= 3) {
        targets.push({ key: `artist:${entity.slug}`, kind: 'artist', slug: entity.slug });
      }
    }
    for (const entity of resolved.best.entities.set) {
      if (entity.slug) targets.push({ key: `set:${entity.slug}`, kind: 'set', slug: entity.slug });
    }
  }
  const intent = live.catalogIntent(text);
  const legacyKey = live.catalogCacheKey(intent);
  if (legacyKey && intent.slug) targets.push({ key: legacyKey, kind: intent.kind, slug: intent.slug });
  const seen = new Set();
  return targets.filter((target) => {
    if (seen.has(target.key) || live.cachedPrintings(target.key).length) return false;
    seen.add(target.key);
    return true;
  });
}

/** One catalog's cards, remembered: `{ cards }` once landed. */
function hydrateTarget(live, target, lang) {
  const landed = (cards, remember) => {
    live.rememberPrintings(target.key, cards);
    if (remember) live.rememberSuggestGroups(live.groupsFromCards(cards));
    preloadSuggestThumbs(collectPrintingThumbUrls(live.groupsFromCards(cards), suggestThumbSrc));
    return { cards };
  };
  if (target.kind === 'name') {
    return fetchNamePrintings(target.name, { lang }).then((cards) => landed(cards, false));
  }
  if (target.kind === 'artist') {
    return fetchArtist(target.slug, { limit: 80 }).then((data) => landed(live.cardsWithCatalogArtist(data), true));
  }
  // A matching name may sit beyond the first set page: hydrate the whole catalog.
  return fetchExpansionCards({ slug: target.slug }).then((data) => landed(data?.cards || [], true));
}

/** Thumbs + per-card shade buckets for rows about to show (the popup's `flat` effect). */
function warmRows(rows, preloadRows = rows) {
  preloadSuggestThumbs(
    collectPrintingThumbUrls([{ printings: preloadRows.map((row) => row.printing) }], suggestThumbSrc),
    { first: true },
  );
  const live = engine();
  for (const row of rows) {
    const card = row.card;
    if (!card.id || (live && live.isLiveStub(card))) continue;
    rememberDeskIdentity(card);
    const shade = albumShade(card);
    if (shade) {
      rememberCardBucket(card.id, shade);
      continue;
    }
    warmCardBucket(card.id, thumbOf(card));
  }
}

/** Resolves once `url` loaded or failed (never rejects). */
function loadedImage(url) {
  return new Promise((resolve) => {
    if (!url || typeof Image === 'undefined') {
      resolve();
      return;
    }
    const img = new Image();
    img.onload = resolve;
    img.onerror = resolve;
    img.src = url;
  });
}

const prewarmed = new Map();

/**
 * Run a whole query ahead of time (the landing's Popular chips): the engine,
 * every suggest page and catalog the popup would read, and the results-page
 * total, all in the caches the popup reads. With `thumbs`, the first rows'
 * pictures are loaded and their shades warmed too. A chip filled with
 * `fillSuggest` then paints its final list in its first frame: no
 * "Searching…", no re-rank, no count change. Ranking is untouched: the popup
 * still ranks at paint time, it just finds everything already there.
 */
export function prewarmSuggest(text, { lang, printLang: print = 'all', tab = 'singles', thumbs = false } = {}) {
  const q = String(text || '').trim();
  if (!q) return Promise.resolve();
  const key = `${lang}\0${print}\0${tab}\0${q}`;
  let entry = prewarmed.get(key);
  if (!entry) {
    entry = {
      data: (async () => {
        const live = await loadSuggestEngine();
        await Promise.all([
          pageUniverse(live, q, { lang, print }),
          ...catalogTargets(live, q, lang).map((target) => hydrateTarget(live, target, lang).catch(() => null)),
          prefetchSearchPage(q, lang, { fetchSearchPage: fetchSearchRecall, tab, printLang: print }).catch(() => null),
        ]);
        return live;
      })(),
      thumbs: null,
    };
    entry.data.catch(() => prewarmed.delete(key));
    prewarmed.set(key, entry);
  }
  if (!thumbs) return entry.data;
  entry.thumbs ||= entry.data.then((live) => {
    const paint = (limit) => live.paintCatalogGroups(q, { printLang: print, searchLang: lang, kind: tab, limit });
    const interest = buildInterestProfile(readInterestEvents('pokemon'), { print, eraOf: live.matchTcgEra });
    const rows = flattenSuggestRows(personalPopup(paint, q, interest, { eraOf: live.matchTcgEra }));
    warmRows(rows);
    // The <img> CardArt renders first for each row in view (its first raster sibling).
    const urls = rows.slice(0, SUGGEST_THUMB_EAGER).map((row) => cdnFetchUrl(rasterSiblings(suggestThumbSrc(row.printing))[0] || '')).filter(Boolean);
    return Promise.all(urls.map(loadedImage));
  });
  return entry.thumbs;
}

/**
 * Put a whole query in the box at once (a landing Popular chip): `term`
 * commits with the input instead of a paint later, so after prewarmSuggest
 * the popup's first frame is the final list. `input` is the SearchBox field.
 */
export function fillSuggest(input, value) {
  input.dispatchEvent(new CustomEvent('suggest-fill', { detail: String(value || '') }));
}

/** Dividers follow the groups that are actually next to each other after a rotation. */
function withGroupStarts(rows) {
  let prevGroup = null;
  return rows.map((row, index) => {
    const groupStart = index > 0 && row.group !== prevGroup;
    prevGroup = row.group;
    if (row.groupStart === groupStart) return row;
    return { ...row, groupStart };
  });
}

/**
 * Header search + typeahead. The input
 * repaints on every keystroke on its own; the ranking, network paging and
 * catalog hydration run on `term`, committed after that paint. Rows are one
 * flat list keyed by card id, so a printing that changes group stays the same
 * `<li>` (FLIP slides it) instead of remounting inside a new group.
 *
 * `hero` is the pokoin.com landing (solid/src/landing/LandingSearch.jsx): the
 * same box, pickers and popup in the large hero field, with a visible Search
 * button. It mounts at idle, so its search-universe warmup waits for the
 * first search intent instead of running with the page.
 */
export default function SearchBox(props) {
  const navigate = useGameNavigate();
  const location = useLocation();
  const pokemon = () => isPokemonGame();
  const inputId = props.inputId || 'market-search';
  const [intent, setIntent] = createSignal(!props.hero);
  const onIntent = () => {
    setIntent(true);
    loadSuggestEngineOnIntent();
  };
  const [query, setQuery] = createSignal('');
  const [term, setTerm] = createSignal('');
  const [open, setOpen] = createSignal(false);
  const [searchTab, setSearchTab] = createSignal('singles');
  const [activeIndex, setActiveIndex] = createSignal(-1);
  const [pointerHoverId, setPointerHoverId] = createSignal(null);
  const [hoverBox, setHoverBox] = createSignal(null);
  const [hitCount, setHitCount] = createSignal(0);
  let countedQuery = '';
  const [liveTick, setLiveTick] = createSignal(0);
  const [epoch, setEpoch] = createSignal(0);
  const [shadeTick, setShadeTick] = createSignal(0);
  const [progressivePending, setProgressivePending] = createSignal(false);
  const [sellerHits, setSellerHits] = createSignal([]);
  const [otherGroups, setOtherGroups] = createSignal([]);
  const [otherPending, setOtherPending] = createSignal(false);
  let box;
  let list;
  let panel;
  let termTimer = 0;
  let nextTerm = '';

  const catalogTab = () => (searchTab() === 'users' ? 'singles' : searchTab());

  // Personal predictions (interest-profile.js): this visitor's own recent
  // views, read from their device each time the popup opens, under the
  // current print chip. One or two letters search for the name they have
  // been viewing; three or more search for what was typed, as always.
  const [interestTick, setInterestTick] = createSignal(0);
  const interest = createMemo(() => {
    interestTick();
    if (!pokemon()) return null;
    return buildInterestProfile(readInterestEvents('pokemon'), { print: printLang(), eraOf: engine()?.matchTcgEra || null });
  });
  const predicted = createMemo(() => {
    const text = term().trim();
    if (!pokemon() || !text || searchTab() === 'users' || liveReady(text)) return null;
    return predictInterest(text, interest());
  });
  const searchTerm = () => predicted()?.text || term();
  createEffect(open, (isOpen) => {
    if (isOpen) setInterestTick((tick) => tick + 1);
  });

  // fillSuggest (a landing Popular chip): the whole query, term and all, in one
  // update; the results-page total is applied at once when prewarmSuggest has it.
  function fillWhole(value) {
    onIntent();
    const text = value.trim();
    nextTerm = value;
    setQuery(value);
    setTerm(value);
    setActiveIndex(-1);
    setOpen(true);
    const hot = takeHotSearchPage(text, searchLang(), searchTab(), printLang());
    if (hot?.count > 0) {
      countedQuery = text;
      setHitCount(hot.count);
    }
  }

  function commitTerm(value) {
    nextTerm = value;
    if (termTimer) return;
    termTimer = afterPaint(() => {
      termTimer = 0;
      setTerm(nextTerm);
      setActiveIndex(-1);
    });
  }

  onSettled(() => subscribeShadeBuckets(() => setShadeTick((n) => n + 1)));

  // The print family the rows are ranked for. It trails the chip by one paint,
  // like `term` trails the input: the click closes the menu and flips the flag
  // in a short task, the old rows stay up, and the re-rank runs after that frame.
  const [rankPrint, setRankPrint] = createSignal(untrack(printLang));
  createEffect(printLang, (print) => {
    if (print === untrack(rankPrint)) return undefined;
    let live = true;
    afterPaint(() => {
      if (live) setRankPrint(print);
    });
    return () => {
      live = false;
    };
  });

  // /marketplace/search?q= keeps the box in sync with the results page.
  createEffect(() => [location.pathname, location.search], ([pathname, search]) => {
    if (stripGamePrefix(pathname) !== '/marketplace/search') return;
    const params = new URLSearchParams(search);
    const q = params.get('q');
    if (q) {
      setQuery(q);
      setTerm(q);
    }
    setSearchTab(normalizeSearchTab(params.get('tab')));
  });

  // Language / print-family / tab change refreshes the typed query's universe at once.
  createEffect(() => [searchLang(), printLang(), searchTab(), pokemon(), intent()], ([lang, print, tab, isPokemon, wanted]) => {
    if (!isPokemon || tab === 'users' || !wanted) return;
    const typed = untrack(term).trim();
    // Network-only until the engine is loaded on search intent (no engine eval on mount).
    warmupSearchUniverse({
      lang, printLang: print, query: typed, fetchSearchPage: fetchSearchRecall, force: Boolean(typed), remember: Boolean(untrack(engine)),
    });
  });

  // Progressive network pool (use-progressive-suggest.js): pages of printings for
  // the current generation feed the suggest-live cache; stale pages are dropped.
  let pool = null;
  let clock = null;
  createEffect(
    () => [engine(), searchTerm(), searchLang(), rankPrint(), catalogTab(), pokemon() && searchTab() !== 'users'],
    ([live, typed, lang, print, kind, enabled]) => {
      if (!live || !enabled) {
        setProgressivePending(false);
        return undefined;
      }
      pool ||= live.emptyPool();
      clock ||= live.createGenerationClock();
      const text = String(typed || '').trim();
      const scope = live.buildScope({ lang, printLang: print, kind, game: 'pokemon', query: text });
      const decision = live.reuseDecision(pool.query, text, pool.scope, scope);
      const generation = clock.next();
      pool.generation = generation;
      pool.scope = scope;
      pool.query = text;
      if (decision.action === 'reset') pool.rows = [];
      if (!text) {
        setProgressivePending(false);
        setEpoch((value) => value + 1);
        return undefined;
      }
      const controller = new AbortController();
      let stopped = false;
      // One gate per generation: the first page repaints now, later pages of
      // this same search share a trailing repaint.
      const repaint = createRepaintGate({
        delay: SUGGEST_REPAINT_MS,
        bump: () => setEpoch((value) => value + 1),
      });
      setProgressivePending(true);
      (async () => {
        try {
          const ended = await pageUniverse(live, text, {
            lang,
            print,
            signal: controller.signal,
            alive: () => !stopped && pool.generation === generation,
            onPage: (page, incoming) => {
              pool.transferred = (pool.transferred || 0) + incoming;
              // Placeholder until the search-page total lands: "View all N" = rows the page lists.
              if (countedQuery !== text) setHitCount(Number(page?.count) || 0);
              repaint.page();
            },
          });
          if (ended === 'stale') pool.stale = (pool.stale || 0) + 1;
        } catch (error) {
          if (error?.name === 'AbortError') pool.cancelled = (pool.cancelled || 0) + 1;
        }
      })().finally(() => {
        if (!stopped && pool.generation === generation) {
          repaint.flush();
          setProgressivePending(false);
        }
      });
      return () => {
        stopped = true;
        controller.abort();
        repaint.dispose();
      };
    },
  );

  // Catalog hydration (name / artist / set printings the local resolver points
  // at), and the satellite-game suggest path (no local catalog).
  createEffect(
    () => [engine(), searchTerm().trim(), searchLang(), rankPrint(), searchTab(), pokemon()],
    ([live, text, lang, , tab, isPokemon]) => {
      if (!text) {
        setOtherPending(false);
        setOtherGroups([]);
        setHitCount(0);
        return undefined;
      }
      const ready = liveReady(text);
      if (isPokemon) {
        if (!ready) {
          setOtherGroups([]);
          setHitCount(0);
        } else if (live) {
          hydrateCatalog(live, text, lang);
        }
        return undefined;
      }
      if (!ready) {
        setOtherPending(false);
        setOtherGroups([]);
        setHitCount(0);
        return undefined;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => {
        setOtherPending(true);
        // Satellite catalogs have no print nationality: never inherit the Pokémon chip.
        fetchSuggest(text, { limit: 20, signal: controller.signal, lang, printLang: 'all' })
          .then((data) => {
            const groups = (Array.isArray(data.groups) ? data.groups : [])
              .map((group) => ({ ...group, printings: (group.printings || []).filter((row) => printingMatchesSearchTab(row, tab)) }))
              .filter((group) => group.printings.length > 0);
            if (controller.signal.aborted) return;
            setOtherGroups(groups);
            setHitCount(groups.reduce((sum, group) => sum + group.printings.length, 0));
            setActiveIndex(-1);
            prefetchSearchPage(text, lang, { fetchSearchPage: fetchSearchRecall, signal: controller.signal, tab, printLang: 'all' });
          })
          .catch((error) => {
            if (error.name !== 'AbortError') setActiveIndex(-1);
          })
          .finally(() => {
            if (!controller.signal.aborted) setOtherPending(false);
          });
      }, 120);
      return () => {
        controller.abort();
        clearTimeout(timer);
      };
    },
  );

  function hydrateCatalog(live, text, lang) {
    for (const target of catalogTargets(live, text, lang)) {
      hydrateTarget(live, target, lang)
        .then(() => {
          if (liveReady(String(untrack(searchTerm) || '').trim())) setLiveTick((tick) => tick + 1);
        })
        .catch(() => {});
    }
  }

  // Users tab: seller handles, 160 ms after the last keystroke.
  createEffect(() => [open(), term().trim(), searchTab()], ([isOpen, handle, tab]) => {
    if (!isOpen || tab !== 'users' || !liveReady(handle)) {
      setSellerHits([]);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchSellerSearchWithAssociates(handle, { limit: 20 })
        .then((data) => {
          if (!cancelled) setSellerHits(Array.isArray(data?.listings) ? data.listings : []);
        })
        .catch(() => {
          if (!cancelled) setSellerHits([]);
        });
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

  // "View all N": the search-page total for this exact query + tab + print
  // family, asked once typing pauses. Each keystroke used to fetch a results
  // page (and its recall lookups) for a prefix nobody would open; the count
  // shows the suggest estimate until the real one lands, and Enter prefetches
  // on its own (goSearch).
  createEffect(() => [open(), searchTerm().trim(), searchTab(), searchLang(), printLang(), pokemon()], ([isOpen, text, tab, lang, print, isPokemon]) => {
    if (!isOpen || !isPokemon || tab === 'users' || !liveReady(text) || text.length < 2) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      prefetchSearchPage(text, lang, { fetchSearchPage: fetchSearchRecall, tab, printLang: print })
        .then((payload) => {
          const total = Number(payload?.total);
          if (!cancelled && Number.isFinite(total) && total > 0) {
            countedQuery = text;
            setHitCount(total);
          }
        })
        .catch(() => {});
    }, RESULTS_COUNT_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

  const visibleGroups = createMemo(() => {
    if (!pokemon()) return otherGroups();
    const live = engine();
    const text = searchTerm();
    if (!live || !live.suggestLiveReady(text) || searchTab() === 'users') return [];
    epoch();
    liveTick();
    // The visitor's own order on top of the ranking: viewed names first among
    // names that start with the text, their era first within a name.
    const paint = (limit) => live.paintCatalogGroups(text, {
      printLang: rankPrint(), searchLang: searchLang(), kind: catalogTab(), limit,
    });
    return personalPopup(paint, text, interest(), { eraOf: live.matchTcgEra });
  });
  // Read once: the default is off, so a mount with the flag closed never
  // builds the deeper pool or advances a rotate step.
  const rotateOn = suggestRotateEnabled();
  let rotateState = { term: '', headKey: '', step: 0 };
  let rotatePreload = [];
  const flat = createMemo(() => {
    rotatePreload = [];
    const head = flattenSuggestRows(visibleGroups());
    if (!rotateOn || !pokemon() || searchTab() === 'users') return withGroupStarts(head);
    const live = engine();
    const text = searchTerm();
    if (!live || !live.suggestLiveReady(text)) return withGroupStarts(head);
    const paint = (limit) => live.paintCatalogGroups(text, {
      printLang: rankPrint(), searchLang: searchLang(), kind: catalogTab(), limit,
    });
    const deep = flattenSuggestRows(personalPopup(paint, text, interest(), {
      eraOf: live.matchTcgEra,
      limit: SUGGEST_ROTATE_POOL,
      pool: SUGGEST_ROTATE_POOL,
    }));
    const seen = new Set(head.map((row) => row.key));
    const ranked = head.slice();
    for (const row of deep) {
      if (ranked.length >= SUGGEST_ROTATE_POOL) break;
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      ranked.push(row);
    }
    const headKey = ranked.slice(0, SUGGEST_ROTATE_HEAD).map((row) => row.key).join('|');
    rotateState = nextRotateState(rotateState, { term: text.trim(), headKey });
    // Step 0 is today's head, even when the deeper pool is longer than 20.
    const shown = rotateState.step === 0 ? head : rotateTail(ranked, { step: rotateState.step });
    const shownKeys = new Set(shown.map((row) => row.key));
    rotatePreload = rotateTail(ranked, { step: rotateState.step + 1 }).filter((row) => !shownKeys.has(row.key));
    return withGroupStarts(shown);
  });
  // The one frame where `term` trails the input also reads as pending, never as "no match".
  const suggestPending = () => (pokemon() && searchTab() !== 'users'
    ? progressivePending() || !engine() || term() !== query() || rankPrint() !== printLang()
    : otherPending() || term() !== query());
  // One typing session (suggest-hold.js): once open, the popup stays up and
  // keeps its last rows while the next keystroke's rows are on their way.
  let session = SUGGEST_SESSION_CLOSED;
  const popup = createMemo(() => {
    session = nextSuggestSession(session, {
      open: open(),
      query: query(),
      ready: liveReady(query()) || Boolean(predicted()),
      pending: suggestPending(),
      rows: flat(),
      scope: `${searchTab()}|${rankPrint()}|${pokemon()}`,
      pokemon: pokemon(),
    });
    return session;
  });
  const suggestVisible = () => popup().visible;
  const shownRows = () => popup().rows;
  const activeOption = () => (activeIndex() >= 0 ? shownRows()[activeIndex()] : null);
  const suggestIds = () => (open() ? shownRows().map((row) => String(row.card.id)).join('|') : '');

  // Thumbs + per-card shade buckets for the rows on screen.
  // Rotation may also warm the next tail page; it never preloads the whole pool.
  createEffect(flat, (rows) => {
    if (!rows.length) return;
    warmRows(rows, rotatePreload.length ? rows.concat(rotatePreload) : rows);
  });

  // Fit long titles, then FLIP rows to their new slots (same order as React).
  const flip = createSuggestFlip();
  createEffect(() => (suggestVisible() ? suggestIds() : ''), (ids) => {
    if (!ids || !list) return undefined;
    fitSuggestTitles(list);
    flip.update(list);
    let width = list.clientWidth;
    let alive = true;
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
        if (!list || list.clientWidth === width) return;
        width = list.clientWidth;
        fitSuggestTitles(list, { reset: true });
      })
      : null;
    observer?.observe(list);
    if (document.fonts && document.fonts.status !== 'loaded') {
      document.fonts.ready.then(() => {
        if (alive && list) fitSuggestTitles(list, { reset: true });
      });
    }
    return () => {
      alive = false;
      observer?.disconnect();
      flip.dispose();
    };
  });

  // Outside mousedown closes the popup (the language toggles are part of the box).
  createEffect(open, (isOpen) => {
    if (!isOpen) {
      setPointerHoverId(null);
      return undefined;
    }
    const onDoc = (event) => {
      const target = event.target;
      if (box && box.contains(target)) return;
      if (typeof target?.closest === 'function' && target.closest('.lang-toggle')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  });

  // Hover preview of the pointed / keyboard-active row (desktop pointers only).
  const previewOptionId = () => pointerHoverId() || activeOption()?.optionId || '';
  const hoverCard = () => {
    const id = previewOptionId();
    const row = id ? shownRows().find((item) => item.optionId === id) : null;
    const live = engine();
    return row && !(live && live.isLiveStub(row.card)) ? row.card : null;
  };
  const hoverHero = () => (hoverCard() ? imageSrc(hoverCard(), 'hero') : '');
  const hoverSrc = () => pickSuggestHoverSrc(hoverHero(), hoverCard() ? imageSrc(hoverCard(), 'suggest') : '');
  createEffect(() => [open(), previewOptionId(), hoverSrc(), suggestIds()], ([isOpen, optionId, src]) => {
    if (!isOpen || !optionId || !src) {
      setHoverBox(null);
      return undefined;
    }
    const place = () => {
      if (!suggestHoverAllowed(window.innerWidth, window.matchMedia('(hover: hover)').matches)) {
        setHoverBox(null);
        return;
      }
      const row = document.getElementById(optionId);
      if (!panel || !row) {
        setHoverBox(null);
        return;
      }
      const panelRect = panel.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const next = suggestHoverBox({
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        panelLeft: panelRect.left,
        panelRight: panelRect.right,
        rowTop: rowRect.top,
        rowHeight: rowRect.height,
      });
      setHoverBox((prev) => (sameSuggestHoverBox(prev, next) ? prev : next));
    };
    place();
    const scroller = panel?.querySelector('.suggest-list');
    window.addEventListener('resize', place);
    scroller?.addEventListener('scroll', place, { passive: true });
    return () => {
      window.removeEventListener('resize', place);
      scroller?.removeEventListener('scroll', place);
    };
  });

  function goSearch(event) {
    event?.preventDefault?.();
    const next = query().trim();
    setOpen(false);
    props.onNavigate?.();
    if (next) prefetchSearchPage(next, searchLang(), { fetchSearchPage: fetchSearchRecall, tab: searchTab(), printLang: printLang() });
    navigateAfterPaint(() => navigate(searchHref(next, searchTab())));
  }

  function pick(card, rank) {
    const live = engine();
    if (live && live.isLiveStub(card)) return;
    const mapped = cardFromAutocomplete(card);
    if (live && live.isLiveStub(mapped)) return;
    setOpen(false);
    setQuery(mapped.name || '');
    track(Action.clickSuggest, mapped, { query: query(), resultRank: rank });
    // Warm the card-page payload so the desk paints themed on arrival.
    warmupCard(mapped, { lang: searchLang() });
    handOffCard(mapped);
    navigateAfterPaint(() => navigate(cardHref(mapped)));
  }

  function onKeyDown(event) {
    if (!open()) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, shownRows().length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, -1));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      setActiveIndex(-1);
    } else if (event.key === 'Enter' && activeOption()) {
      event.preventDefault();
      const option = activeOption();
      const live = engine();
      if (live && live.isLiveStub(option.card)) {
        goSearch(event);
        return;
      }
      pick(option.card, activeIndex());
    }
  }

  return (
    <form class={['search', { 'search-hero': props.hero }]} onSubmit={goSearch} role="search" ref={(node) => { box = node; }}>
      <label class="sr-only" for={inputId}>{props.label || 'Search cards'}</label>
      <div class="search-pill">
        <div class="search-lead">
          <GameSelect />
          <LangToggle />
        </div>
        <input
          id={inputId}
          type="search"
          role="combobox"
          ref={(node) => node.addEventListener('suggest-fill', (event) => fillWhole(String(event.detail || '')))}
          value={query()}
          onInput={(event) => {
            onIntent();
            const value = event.currentTarget.value;
            setQuery(value);
            setOpen(true);
            commitTerm(value);
          }}
          onPointerDown={onIntent}
          onFocus={() => {
            setOpen(true);
            onIntent();
          }}
          onKeyDown={onKeyDown}
          placeholder={props.placeholder || (props.extensionDesk ? 'Search cards' : 'Search cards, sets, products...')}
          autocomplete="off"
          aria-expanded={ariaBool(suggestVisible())}
          aria-controls="market-suggest"
          aria-activedescendant={activeOption()?.optionId}
          aria-autocomplete="list"
          aria-busy={ariaBool(suggestVisible() && suggestPending())}
        />
        <Show when={pokemon()}><PrintLangToggle /></Show>
        <button class={props.hero ? 'search-go' : 'sr-only'} type="submit">Search</button>
      </div>
      <Show when={suggestVisible()}>
        <div
          class="suggest"
          id="market-suggest"
          ref={(node) => { panel = node; }}
          onMouseLeave={() => setPointerHoverId(null)}
        >
          <Show when={pokemon()}>
            <SearchTabs value={searchTab()} onChange={(tab) => { setSearchTab(tab); setActiveIndex(-1); }} ariaLabel="Search type" />
          </Show>
          <Show
            when={searchTab() !== 'users'}
            fallback={(
              <ul class="suggest-list" role="listbox" aria-label="Seller suggestions">
                <Show
                  when={sellerHits().length}
                  fallback={<li class="suggest-empty">No sellers match “{query().trim()}”.</li>}
                >
                  <For each={uniqueSellers(sellerHits(), query().trim())}>
                    {(seller) => (
                      <li>
                        <button
                          type="button"
                          class="suggest-user"
                          onClick={() => {
                            setOpen(false);
                            navigateAfterPaint(() => navigate(sellerHref({ sellerName: seller.username })));
                          }}
                        >
                          <span class="suggest-user-mark" aria-hidden="true">{seller.name.slice(0, 1).toUpperCase()}</span>
                          <span class="suggest-copy">
                            <strong>{seller.name}</strong>
                            <Show when={seller.associateRole}>
                              <span class={`suggest-user-associate-badge is-${seller.associateRole}`}>{associateRoleLabel(seller.associateRole)}</span>
                            </Show>
                            <Show when={seller.count}>
                              <em>{seller.count} listing{seller.count === 1 ? '' : 's'}</em>
                            </Show>
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </Show>
              </ul>
            )}
          >
            <Show when={predicted()}>
              {(guess) => (
                <p class="suggest-hint">
                  Because you viewed <strong>{guess().text}</strong>
                </p>
              )}
            </Show>
            <ul class="suggest-list" role="listbox" aria-label="Card suggestions" ref={(node) => { list = node; }}>
              <Show
                when={shownRows().length}
                fallback={(
                  <li class="suggest-empty">
                    {suggestPending()
                      ? 'Searching…'
                      : searchTab() === 'product'
                        ? `No products match “${query().trim()}”.`
                        : `No singles match “${query().trim()}”.`}
                  </li>
                )}
              >
                <For each={shownRows()} keyed={(row) => row.key}>
                  {(row, index) => (
                    <SuggestRow
                      pokemon={pokemon()}
                      printing={row().printing}
                      groupName={row().groupName}
                      groupStart={row().groupStart}
                      index={index()}
                      activeId={activeOption()?.optionId}
                      shadeTick={shadeTick()}
                      live={engine()}
                      onHover={setPointerHoverId}
                      onPick={pick}
                    />
                  )}
                </For>
              </Show>
            </ul>
          </Show>
          <Show when={query().trim().length >= 2 && searchTab() !== 'users'}>
            <button class="suggest-all" type="submit">
              {hitCount() > 0
                ? `View all ${hitCount().toLocaleString('en-US')} results`
                : `View all results for “${query().trim()}”`}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={open() && hoverSrc() && hoverBox()}>
        <Portal mount={document.body}>
          <div
            class="suggest-hover"
            style={{
              left: `${hoverBox().left}px`,
              top: `${hoverBox().top}px`,
              width: `${hoverBox().width}px`,
              height: `${hoverBox().height}px`,
            }}
            aria-hidden="true"
          >
            <CardArt src={hoverSrc()} full={Boolean(hoverHero())} alt="" />
          </div>
        </Portal>
      </Show>
    </form>
  );
}

/** One printing row of the popup (same markup as the React row). */
function SuggestRow(props) {
  // Derived once per printing change: each read below used to re-run the
  // card mapping, image URL and era matching for every attribute that used it.
  const card = createMemo(() => cardOf(props.printing));
  const identity = createMemo(() => printingIdentity(card()));
  const englishName = createMemo(() => suggestCardName(card(), props.groupName));
  const artLayout = createMemo(() => (props.pokemon ? resolveArtLayout({ ...card(), name: englishName() }) : 'window'));
  const landscapePrint = () => artLayout() === 'landscape';
  const bleedPrint = () => artLayout() === 'bleed' || artLayout() === 'item';
  const number = createMemo(() => clipSuggestCollector(identity().number));
  const translation = createMemo(() => suggestTranslatedLine(card(), englishName(), number()));
  const optionId = () => `suggest-${card().id}`;
  const active = () => props.activeId === optionId();
  const thumb = createMemo(() => thumbOf(card()));
  const printFlag = createMemo(() => {
    const bucket = rowPrintBucket(card());
    return printFlagFromNationality(bucket === 'unknown' ? '' : bucket);
  }, {
    equals: (prev, next) => prev?.code === next?.code && prev?.label === next?.label,
  });
  const live = createMemo(() => Boolean(props.live && (props.live.isLiveStub(card()) || props.live.isLiveStub(props.printing))));
  const rowTheme = createMemo(() => {
    void props.shadeTick;
    const special = rarityRowTheme(card());
    const delta = !special && prefersArtworkDelta(card()) ? deskTheme(card()) : null;
    if (special?.shade) return special;
    if (delta) return { kind: 'delta', shade: delta.surface, raised: delta.surfaceRaised };
    return special;
  });
  const thumbLoading = () => (props.index >= SUGGEST_THUMB_EAGER ? 'lazy' : undefined);
  const thumbPriority = () => (props.index < SUGGEST_THUMB_HIGH ? 'high' : 'low');
  const choose = () => {
    if (!live()) props.onPick(card(), props.index);
  };
  return (
    <Show when={card().id}>
      <li
        class={{ 'is-group-start': props.groupStart }}
        data-suggest-id={card().id}
        role="option"
        id={optionId()}
        aria-selected={ariaBool(active())}
        aria-disabled={live() || undefined}
        onMouseEnter={() => {
          if (live()) return;
          props.onHover(optionId());
          const hero = imageSrc(card(), 'hero');
          if (hero) {
            const preload = new Image();
            preload.src = hero;
          }
        }}
      >
        <div
          class={['suggest-row', {
            'is-active': active(),
            'is-shaded': Boolean(rowTheme()?.shade),
            'is-rainbow': rowTheme()?.kind === 'rainbow',
            'is-gold': rowTheme()?.kind === 'gold',
            'is-ghost': rowTheme()?.kind === 'ghost',
          }]}
          style={rowTheme()?.shade ? { '--suggest-shade': rowTheme().shade, '--suggest-shade-raised': rowTheme().raised } : undefined}
        >
          <button type="button" class="suggest-main" onClick={choose}>
            <span class="suggest-set" aria-hidden="true">
              <span class="set-shortcut is-on">
                <ExpansionMark
                  setName={identity().set}
                  number={card().number || card().card_number}
                  cardId={card().id}
                  symbolUrl={card().expansionSymbolUrl}
                />
              </span>
            </span>
            <Show when={thumb()} fallback={<span class="suggest-ph" />}>
              <CardArt src={thumb()} alt="" loading={thumbLoading()} fetchPriority={thumbPriority()} dragCard={live() ? undefined : card()} />
            </Show>
            <span class="suggest-copy">
              <span class="suggest-number">{number()}</span>
              <span class="suggest-copy-text">
                <strong>
                  {englishName()}
                  <Show when={number()}><span class="suggest-num-phone"> - {number()}</span></Show>
                </strong>
                <Show when={translation()}><span class="suggest-translated">{translation()}</span></Show>
                <Show when={identity().suggestExpansionShort}>
                  <em title={identity().suggestExpansion}>{identity().suggestExpansionShort}</em>
                </Show>
              </span>
            </span>
          </button>
          <Show when={props.pokemon && (thumb() || printFlag())}>
            <div class="suggest-art-cluster">
              <Show when={printFlag()}>
                <span class="suggest-print-flag">
                  <img src={flagSrc(printFlag().code)} alt="" width="40" height="40" />
                  <span class="sr-only">{printFlag().label}</span>
                </span>
              </Show>
              <Show when={thumb()}>
                <button
                  type="button"
                  class={['suggest-art', { 'is-landscape': landscapePrint(), 'is-bleed': bleedPrint() && !landscapePrint() }]}
                  tabindex="-1"
                  aria-hidden="true"
                  onClick={choose}
                >
                  <CardArt
                    src={thumb()}
                    card={card()}
                    dragCard={live() ? undefined : card()}
                    cut={artLayout() === 'window' || artLayout() === 'halfart'}
                    loading={thumbLoading()}
                    fetchPriority={thumbPriority()}
                  />
                </button>
              </Show>
            </div>
          </Show>
        </div>
      </li>
    </Show>
  );
}
