import { createEffect, createMemo, createSignal, onSettled } from 'solid-js';
import {
  fetchArtist,
  fetchExpansionCards,
  fetchNamePrintings,
  fetchSuggest,
  imageSrc,
} from '@market/api.js';
import { compactQuery } from '@market/compact-query.js';
import { isPokemonGame } from '@market/game.js';
import { collectPrintingThumbUrls, preloadSuggestThumbs } from '@market/suggest-images.js';
import { warmupSuggestRankWorkers } from '@market/suggest-rank-runtime.js';
import { loadSuggestEngine } from '../components/SearchBox.jsx';
import { printLang, searchLang } from '../stores/locale.js';

/**
 * Same typeahead engine as the header search bar, as a flat list of pickable
 * printings: the Solid port of market/src/use-live-suggest.js (+ its
 * use-progressive-suggest.js pool). Keystrokes paint from the local ranker
 * (paintCatalogGroups); progressive Meili pages and catalog hydration only
 * feed the suggest-live cache and bump a tick so the list re-reads it. Every
 * query / language / print change aborts the in-flight requests (D00005W).
 * docs/TYPEAHEAD.md
 */

function suggestThumbSrc(card) {
  try {
    return imageSrc(card, 'suggest');
  } catch (_) {
    return '';
  }
}

function flattenPickable(groups, isLiveStub) {
  const rows = [];
  for (const group of groups || []) {
    for (const printing of group.printings || []) {
      if (isLiveStub(printing)) continue;
      const card = {
        id: String(printing.card_id || printing.id || ''),
        name: printing.name || group.name || '',
        set: printing.set_name || printing.set || '',
        number: printing.collector_number || printing.number || '',
        image: printing.image || printing.cdn_image_url || printing.image_url || '',
      };
      if (!/^\d+$/.test(card.id)) continue;
      if (!card.image) {
        try {
          card.image = imageSrc({ id: card.id, name: card.name }, 'suggest');
        } catch (_) {
          /* leave empty */
        }
      }
      rows.push(card);
    }
  }
  return rows;
}

/**
 * @param {() => string} query
 * @param {{ kind?: string, limit?: number }} [opts]
 * @returns {() => Array} pickable printings
 */
export function createLiveSuggest(query, { kind = 'singles', limit = 20 } = {}) {
  const [engine, setEngine] = createSignal(null);
  const [liveTick, setLiveTick] = createSignal(0);
  const [epoch, setEpoch] = createSignal(0);
  const pokemon = isPokemonGame();
  let current = '';

  onSettled(() => {
    warmupSuggestRankWorkers();
    let live = true;
    loadSuggestEngine().then((mod) => {
      if (live) setEngine(() => mod);
    }).catch(() => {});
    return () => {
      live = false;
    };
  });

  const bump = () => {
    const live = engine();
    if (live && live.suggestLiveReady(String(current || '').trim())) setLiveTick((tick) => tick + 1);
  };

  // Progressive network pool: pages for the current generation feed the cache.
  let pool = null;
  let clock = null;
  createEffect(
    () => [engine(), String(query() || '').trim(), searchLang(), printLang()],
    ([live, term, lang, print]) => {
      if (!live || !pokemon) return undefined;
      pool ||= live.emptyPool();
      clock ||= live.createGenerationClock();
      const scope = live.buildScope({ lang, printLang: print, kind, game: 'pokemon', query: term });
      const decision = live.reuseDecision(pool.query, term, pool.scope, scope);
      const generation = clock.next();
      pool.generation = generation;
      pool.scope = scope;
      pool.query = term;
      if (decision.action === 'reset') pool.rows = [];
      if (!term) {
        setEpoch((value) => value + 1);
        return undefined;
      }
      const controller = new AbortController();
      let stopped = false;
      (async () => {
        for (const lookup of live.catalogRecall(term)) {
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
            } catch (_) {
              return;
            }
            if (stopped || pool.generation !== generation) return;
            live.rememberSuggestGroups(page?.groups, { searchLang: lang });
            const incoming = (page?.groups || []).reduce((sum, group) => sum + (group.printings || []).length, 0);
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
      })();
      return () => {
        stopped = true;
        controller.abort();
      };
    },
  );

  // Catalog hydration (name / artist / set printings the resolver points at),
  // and the satellite-game Meili suggest (no local catalog).
  createEffect(
    () => [engine(), String(query() || '').trim(), searchLang(), printLang()],
    ([live, term, lang, print]) => {
      current = term;
      if (!live || !term) return undefined;
      const ready = live.suggestLiveReady(term);
      if (pokemon) {
        if (!ready) return undefined;
        const resolved = live.resolveSuggestQuery(term);
        const targets = [];
        const prefixName = live.earlySetPrefixName(term, { lang });
        if (prefixName) targets.push({ key: `prefix-name:${lang}:${prefixName}`, kind: 'name', name: prefixName });
        if (resolved?.best) {
          for (const entity of resolved.best.entities.artist) {
            if (entity.slug) targets.push({ key: `artist:${entity.slug}`, kind: 'artist', slug: entity.slug });
          }
          for (const entity of resolved.best.entities.set) {
            if (entity.slug) targets.push({ key: `set:${entity.slug}`, kind: 'set', slug: entity.slug });
          }
        }
        const intent = live.catalogIntent(term);
        const legacyKey = live.catalogCacheKey(intent);
        if (legacyKey && intent.slug) targets.push({ key: legacyKey, kind: intent.kind, slug: intent.slug });
        const seen = new Set();
        const remember = (target, cards, groups) => {
          live.rememberPrintings(target.key, cards);
          if (groups) live.rememberSuggestGroups(groups);
          preloadSuggestThumbs(collectPrintingThumbUrls(live.groupsFromCards(cards), suggestThumbSrc));
          bump();
        };
        for (const target of targets) {
          if (seen.has(target.key) || live.cachedPrintings(target.key).length) continue;
          seen.add(target.key);
          if (target.kind === 'name') {
            fetchNamePrintings(target.name, { lang }).then((cards) => remember(target, cards)).catch(() => {});
          } else if (target.kind === 'artist') {
            fetchArtist(target.slug, { limit: 80 })
              .then((data) => {
                const cards = live.cardsWithCatalogArtist(data);
                remember(target, cards, live.groupsFromCards(cards));
              })
              .catch(() => {});
          } else {
            // Later set pages contribute candidates to the same scorer.
            fetchExpansionCards({ slug: target.slug })
              .then((data) => {
                const cards = data?.cards || [];
                remember(target, cards, live.groupsFromCards(cards));
              })
              .catch(() => {});
          }
        }
        return undefined;
      }
      if (!ready) return undefined;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        fetchSuggest(term, { limit, signal: controller.signal, lang, printLang: print })
          .then((data) => {
            if (controller.signal.aborted) return;
            live.rememberSuggestGroups(data.groups);
            setLiveTick((tick) => tick + 1);
          })
          .catch(() => {});
      }, 120);
      return () => {
        controller.abort();
        clearTimeout(timer);
      };
    },
  );

  return createMemo(() => {
    const live = engine();
    const term = String(query() || '');
    liveTick();
    epoch();
    if (!live || !live.suggestLiveReady(term)) return [];
    const groups = live.paintCatalogGroups(term, { printLang: printLang(), searchLang: searchLang(), kind, limit });
    return flattenPickable(groups, live.isLiveStub).slice(0, limit);
  });
}
