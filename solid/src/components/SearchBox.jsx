import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from 'solid-js';
import { Portal } from '@solidjs/web';
import { useLocation, useNavigate } from '@solidjs/router';
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
import { isPokemonGame } from '@market/game.js';
import { clipSuggestCollector, printingIdentity, suggestCardName, suggestTranslatedLine } from '@market/identity.js';
import { sellerHref } from '@market/listing-meta.js';
import { flagSrc, printFlagFromNationality, rowPrintBucket } from '@market/locale.js';
import { prefersArtworkDelta, rarityRowTheme } from '@market/rarity-theme.js';
import { prefetchSearchPage } from '@market/search-hot.js';
import { normalizeSearchTab, printingMatchesSearchTab, searchHref, uniqueSellers } from '@market/search-kind.js';
import { warmupSearchUniverse } from '@market/search-warmup.js';
import { createSuggestFlip } from '@market/suggest-flip.js';
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

function flattenPrintings(groups) {
  const rows = [];
  (groups || []).forEach((group) => {
    (group.printings || []).forEach((printing) => {
      if (!printing || typeof printing !== 'object') return;
      const card = cardOf(printing);
      if (!card.id) return;
      rows.push({ card, printing, group, optionId: `suggest-${card.id}` });
    });
  });
  return rows;
}

/**
 * Header search + typeahead (market/src/components/Chrome.jsx). The input
 * repaints on every keystroke on its own; the ranking, network paging and
 * catalog hydration run on `term`, committed after that paint. Rows are keyed
 * by card id, so a re-rank moves and patches existing rows (FLIP) instead of
 * rebuilding the list.
 */
export default function SearchBox(props) {
  const navigate = useNavigate();
  const location = useLocation();
  const pokemon = isPokemonGame();
  const [query, setQuery] = createSignal('');
  const [term, setTerm] = createSignal('');
  const [open, setOpen] = createSignal(false);
  const [searchTab, setSearchTab] = createSignal('singles');
  const [activeIndex, setActiveIndex] = createSignal(-1);
  const [pointerHoverId, setPointerHoverId] = createSignal(null);
  const [hoverBox, setHoverBox] = createSignal(null);
  const [hitCount, setHitCount] = createSignal(0);
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

  // /marketplace/search?q= keeps the box in sync with the results page.
  createEffect(() => [location.pathname, location.search], ([pathname, search]) => {
    if (pathname !== '/marketplace/search') return;
    const params = new URLSearchParams(search);
    const q = params.get('q');
    if (q) {
      setQuery(q);
      setTerm(q);
    }
    setSearchTab(normalizeSearchTab(params.get('tab')));
  });

  // Language / print-family / tab change refreshes the typed query's universe at once.
  createEffect(() => [searchLang(), printLang(), searchTab()], ([lang, print, tab]) => {
    if (!pokemon || tab === 'users') return;
    const typed = untrack(term).trim();
    // Network-only until the engine is loaded on search intent (no engine eval on mount).
    warmupSearchUniverse({
      lang, printLang: print, query: typed, fetchSearchPage: fetchSearch, force: Boolean(typed), remember: Boolean(untrack(engine)),
    });
  });

  // Progressive network pool (use-progressive-suggest.js): pages of printings for
  // the current generation feed the suggest-live cache; stale pages are dropped.
  let pool = null;
  let clock = null;
  createEffect(
    () => [engine(), term(), searchLang(), printLang(), catalogTab(), pokemon && searchTab() !== 'users'],
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
      setProgressivePending(true);
      (async () => {
        for (const lookup of live.catalogRecall(text)) {
          if (stopped || pool.generation !== generation) return;
          let offset = 0;
          let chunks = 0;
          let fetched = 0;
          const compactLength = compactQuery(lookup).length;
          while (!stopped && pool.generation === generation) {
            const size = live.chunkSize(chunks);
            let page;
            try {
              page = await fetchSuggest(lookup, {
                limit: size, offset, progressive: true, hydrate: true, signal: controller.signal, lang, printLang: print,
              });
            } catch (error) {
              if (error?.name === 'AbortError') pool.cancelled = (pool.cancelled || 0) + 1;
              return;
            }
            if (stopped || pool.generation !== generation) {
              pool.stale = (pool.stale || 0) + 1;
              return;
            }
            live.rememberSuggestGroups(page?.groups, { searchLang: lang });
            const incoming = (page?.groups || []).reduce((sum, group) => sum + (group.printings || []).length, 0);
            pool.transferred = (pool.transferred || 0) + incoming;
            setHitCount(Number(page?.count) || 0);
            fetched += incoming;
            chunks += 1;
            offset = Number.isFinite(Number(page?.nextOffset)) ? Number(page.nextOffset) : offset + incoming;
            setEpoch((value) => value + 1);
            const exhaustive = page?.exhaustive === true || incoming < size;
            if (exhaustive || incoming === 0) break;
            if (fetched >= live.SAFETY_BUDGET || chunks >= live.MAX_CHUNKS) break;
            // One letter prefetches a page. A real name keeps paging its printings.
            if (compactLength <= 2) break;
          }
        }
      })().finally(() => {
        if (!stopped && pool.generation === generation) setProgressivePending(false);
      });
      return () => {
        stopped = true;
        controller.abort();
      };
    },
  );

  // Catalog hydration (name / artist / set printings the local resolver points
  // at), and the satellite-game suggest path (no local catalog).
  createEffect(
    () => [engine(), term().trim(), searchLang(), printLang(), searchTab()],
    ([live, text, lang, , tab]) => {
      if (!text) {
        setOtherPending(false);
        setOtherGroups([]);
        setHitCount(0);
        return undefined;
      }
      const ready = liveReady(text);
      if (pokemon) {
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
            prefetchSearchPage(text, lang, { fetchSearchPage: fetchSearch, signal: controller.signal, tab, printLang: 'all' });
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
    const landed = (key, cards, remember) => {
      live.rememberPrintings(key, cards);
      if (remember) live.rememberSuggestGroups(live.groupsFromCards(cards));
      preloadSuggestThumbs(collectPrintingThumbUrls(live.groupsFromCards(cards), suggestThumbSrc));
      if (liveReady(String(untrack(term) || '').trim())) setLiveTick((tick) => tick + 1);
    };
    for (const target of targets) {
      if (seen.has(target.key) || live.cachedPrintings(target.key).length) continue;
      seen.add(target.key);
      if (target.kind === 'name') {
        fetchNamePrintings(target.name, { lang }).then((cards) => landed(target.key, cards, false)).catch(() => {});
      } else if (target.kind === 'artist') {
        fetchArtist(target.slug, { limit: 80 }).then((data) => landed(target.key, live.cardsWithCatalogArtist(data), true)).catch(() => {});
      } else {
        // A matching name may sit beyond the first set page: hydrate the whole catalog.
        fetchExpansionCards({ slug: target.slug }).then((data) => landed(target.key, data?.cards || [], true)).catch(() => {});
      }
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

  // "View all N": the search-page total for this exact query + tab + print family.
  createEffect(() => [open(), term().trim(), searchTab(), searchLang(), printLang()], ([isOpen, text, tab, lang, print]) => {
    if (!isOpen || !pokemon || tab === 'users' || !liveReady(text) || text.length < 2) return undefined;
    let cancelled = false;
    prefetchSearchPage(text, lang, { fetchSearchPage: fetchSearch, tab, printLang: print })
      .then((payload) => {
        const total = Number(payload?.total);
        if (!cancelled && Number.isFinite(total) && total > 0) setHitCount(total);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  });

  const visibleGroups = createMemo(() => {
    if (!pokemon) return otherGroups();
    const live = engine();
    const text = term();
    if (!live || !live.suggestLiveReady(text) || searchTab() === 'users') return [];
    epoch();
    liveTick();
    return live.paintCatalogGroups(text, { printLang: printLang(), searchLang: searchLang(), kind: catalogTab() });
  });
  const flat = createMemo(() => flattenPrintings(visibleGroups()));
  // The one frame where `term` trails the input also reads as pending, never as "no match".
  const suggestPending = () => (pokemon && searchTab() !== 'users'
    ? progressivePending() || !engine() || term() !== query()
    : otherPending() || term() !== query());
  const suggestVisible = () => open() && liveReady(query()) && (pokemon || visibleGroups().length > 0 || suggestPending());
  const activeOption = () => (activeIndex() >= 0 ? flat()[activeIndex()] : null);
  const suggestIds = () => (open() ? flat().map((row) => String(row.card.id)).join('|') : '');

  // Thumbs + per-card shade buckets for the rows on screen.
  createEffect(visibleGroups, (groups) => {
    if (!groups.length) return;
    preloadSuggestThumbs(collectPrintingThumbUrls(groups, suggestThumbSrc), { first: true });
    const live = engine();
    for (const group of groups) {
      for (const printing of group.printings || []) {
        const card = cardOf(printing);
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
    const row = id ? flat().find((item) => item.optionId === id) : null;
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
    if (next) prefetchSearchPage(next, searchLang(), { fetchSearchPage: fetchSearch, tab: searchTab(), printLang: printLang() });
    navigate(searchHref(next, searchTab()));
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
    navigate(cardHref(mapped));
  }

  function onKeyDown(event) {
    if (!open()) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, flat().length - 1));
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
    <form class="search" onSubmit={goSearch} role="search" ref={(node) => { box = node; }}>
      <label class="sr-only" for="market-search">Search cards</label>
      <div class="search-pill">
        <div class="search-lead">
          <GameSelect />
          <LangToggle />
        </div>
        <input
          id="market-search"
          type="search"
          role="combobox"
          value={query()}
          onInput={(event) => {
            loadSuggestEngineOnIntent();
            const value = event.currentTarget.value;
            setQuery(value);
            setOpen(true);
            commitTerm(value);
          }}
          onPointerDown={loadSuggestEngineOnIntent}
          onFocus={() => {
            setOpen(true);
            loadSuggestEngineOnIntent();
          }}
          onKeyDown={onKeyDown}
          placeholder={props.extensionDesk ? 'Search cards' : 'Search cards, sets, products...'}
          autocomplete="off"
          aria-expanded={ariaBool(suggestVisible())}
          aria-controls="market-suggest"
          aria-activedescendant={activeOption()?.optionId}
          aria-autocomplete="list"
          aria-busy={ariaBool(suggestVisible() && suggestPending())}
        />
        <Show when={pokemon}><PrintLangToggle /></Show>
        <button class="sr-only" type="submit">Search</button>
      </div>
      <Show when={suggestVisible()}>
        <div
          class="suggest"
          id="market-suggest"
          ref={(node) => { panel = node; }}
          onMouseLeave={() => setPointerHoverId(null)}
        >
          <Show when={pokemon}>
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
                            navigate(sellerHref({ sellerName: seller.username }));
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
            <ul class="suggest-list" role="listbox" aria-label="Card suggestions" ref={(node) => { list = node; }}>
              <Show
                when={visibleGroups().length}
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
                <For each={visibleGroups()} keyed={(group) => `${group.name}:${group.printings?.[0]?.id || ''}`}>
                  {(group) => (
                    <li class="suggest-group">
                      <ul>
                        <For each={group().printings || []} keyed={(printing) => String(printing?.id || printing?.card_id || '')}>
                          {(printing) => (
                            <SuggestRow
                              pokemon={pokemon}
                              printing={printing()}
                              groupName={group().name}
                              flat={flat()}
                              activeId={activeOption()?.optionId}
                              shadeTick={shadeTick()}
                              live={engine()}
                              onHover={setPointerHoverId}
                              onPick={pick}
                            />
                          )}
                        </For>
                      </ul>
                    </li>
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
  const rowIndex = createMemo(() => props.flat.findIndex((row) => row.optionId === optionId()));
  const thumbLoading = () => (rowIndex() >= SUGGEST_THUMB_EAGER ? 'lazy' : undefined);
  const thumbPriority = () => (rowIndex() < SUGGEST_THUMB_HIGH ? 'high' : 'low');
  const choose = () => {
    if (!live()) props.onPick(card(), rowIndex());
  };
  return (
    <Show when={card().id}>
      <li
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
                <ExpansionMark setName={identity().set} symbolUrl={card().expansionSymbolUrl} />
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
