/**
 * Same typeahead engine as the header search bar (Chrome.jsx):
 * liveSuggestGroups paint + fetchSuggestRanked Meili hydration.
 * docs/TYPEAHEAD.md
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchArtist,
  fetchExpansion,
  fetchSearch,
  fetchSuggest,
  imageSrc,
} from './api.js';
import { isPokemonGame } from './game.js';
import { usePrintLang, useSearchLang } from './locale.js';
import { catalogCacheKey, catalogIntent, groupsFromCards } from './suggest-catalog.js';
import {
  collectPrintingThumbUrls,
  preloadSuggestThumbs,
} from './suggest-images.js';
import {
  cachedPrintings,
  isLiveStub,
  liveSuggestGroups,
  rememberPrintings,
  rememberSuggestGroups,
  suggestLiveReady,
} from './suggest-live.js';
import { fetchSuggestRanked, rankConcurrency } from './suggest-rank.js';
import { rankChunkOnWorker, warmupSuggestRankWorkers } from './suggest-rank-runtime.js';
import { resolveSuggestQuery } from './suggest-resolve.js';

function suggestThumbSrc(card) {
  try {
    return imageSrc(card, 'suggest');
  } catch (_) {
    return '';
  }
}

function flattenPickable(groups) {
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
 * @param {string} query
 * @param {{ kind?: string, enabled?: boolean, limit?: number }} [opts]
 * @returns {{ results: Array, pending: boolean, ready: boolean }}
 */
export function useLiveSuggest(query, { kind = 'singles', enabled = true, limit = 20 } = {}) {
  const lang = useSearchLang();
  const printLang = usePrintLang();
  const [liveTick, setLiveTick] = useState(0);
  const [pending, setPending] = useState(false);
  const queryRef = useRef('');
  const pokemonScheduled = useRef(new Set());
  const meiliControllers = useRef([]);

  useEffect(() => {
    warmupSuggestRankWorkers();
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const term = String(query || '').trim();
    queryRef.current = term;
    // Match Chrome: drop in-flight Meili work on every keystroke / print change
    // so stale responses cannot pile up and re-paint after a newer query.
    for (const running of meiliControllers.current) running.abort();
    meiliControllers.current = [];
    pokemonScheduled.current.clear();
    if (!term) {
      setPending(false);
      return undefined;
    }

    const ready = suggestLiveReady(term);
    const resolvedOnce = resolveSuggestQuery(term);

    function rememberAndPaint(data) {
      const remembered = data?.hydrated || data?.groups;
      // Stamp with the fetch language so the unified scorer only trusts these
      // rows' localized_* fields while that language stays selected.
      rememberSuggestGroups(remembered, { searchLang: lang });
      preloadSuggestThumbs(collectPrintingThumbUrls(remembered, suggestThumbSrc), { first: true });
      const current = String(queryRef.current || '').trim();
      if (!isPokemonGame() || !suggestLiveReady(current)) return;
      setLiveTick((tick) => tick + 1);
    }

    function hydrateCatalog(nextTerm, resolved) {
      const targets = [];
      if (resolved?.best) {
        for (const entity of resolved.best.entities.artist) {
          if (entity.slug) targets.push({ key: `artist:${entity.slug}`, kind: 'artist', slug: entity.slug });
        }
        for (const entity of resolved.best.entities.set) {
          if (entity.slug) targets.push({ key: `set:${entity.slug}`, kind: 'set', slug: entity.slug });
        }
      }
      const intent = catalogIntent(nextTerm);
      const legacyKey = catalogCacheKey(intent);
      if (legacyKey && intent.slug) {
        targets.push({ key: legacyKey, kind: intent.kind, slug: intent.slug });
      }
      const seen = new Set();
      for (const target of targets) {
        if (seen.has(target.key) || cachedPrintings(target.key).length) continue;
        seen.add(target.key);
        if (target.kind === 'artist') {
          fetchArtist(target.slug, { limit: 80 })
            .then((data) => {
              rememberPrintings(target.key, data.cards);
              rememberSuggestGroups(groupsFromCards(data.cards));
              preloadSuggestThumbs(collectPrintingThumbUrls(groupsFromCards(data.cards), suggestThumbSrc));
              if (suggestLiveReady(String(queryRef.current || '').trim())) {
                setLiveTick((tick) => tick + 1);
              }
            })
            .catch(() => {});
          continue;
        }
        fetchExpansion({ slug: target.slug, limit: 48 })
          .then((data) => {
            const cards = data?.cards || [];
            rememberPrintings(target.key, cards);
            rememberSuggestGroups(groupsFromCards(cards));
            preloadSuggestThumbs(collectPrintingThumbUrls(groupsFromCards(cards), suggestThumbSrc));
            if (suggestLiveReady(String(queryRef.current || '').trim())) {
              setLiveTick((tick) => tick + 1);
            }
          })
          .catch(() => {});
      }
    }

    if (isPokemonGame()) {
      if (ready) hydrateCatalog(term, resolvedOnce);
      const kickKey = `${term}\0${lang}\0${printLang}\0${kind}`;
      if (pokemonScheduled.current.has(kickKey)) return undefined;
      const start = () => {
        if (pokemonScheduled.current.has(kickKey)) return;
        pokemonScheduled.current.add(kickKey);
        const controller = new AbortController();
        meiliControllers.current.push(controller);
        const requestPrint = printLang;
        if (queryRef.current === term) setPending(true);
        fetchSuggestRanked(term, {
          fetchSuggest,
          fetchSearch,
          limit,
          signal: controller.signal,
          lang,
          printLang: requestPrint,
          concurrency: rankConcurrency(),
          mapChunk: rankChunkOnWorker,
          kind,
          resolved: resolvedOnce,
        }).catch((error) => {
          if (error?.name === 'AbortError') throw error;
          return fetchSuggest(term, { limit, signal: controller.signal, lang, printLang: requestPrint })
            .then((data) => ({
              groups: Array.isArray(data.groups) ? data.groups : [],
              hydrated: data.groups,
              count: Number(data.count) || 0,
              resolvedQuery: term,
            }));
        }).then((data) => {
          rememberAndPaint(data);
        }).catch((error) => {
          if (error?.name !== 'AbortError') {
            /* leave live cache as-is */
          }
        }).finally(() => {
          meiliControllers.current = meiliControllers.current.filter((row) => row !== controller);
          if (queryRef.current === term) setPending(false);
        });
      };
      if (pokemonScheduled.current.size === 0) {
        start();
        return undefined;
      }
      const timer = setTimeout(start, 40);
      return () => clearTimeout(timer);
    }

    // Non-Pokemon: plain Meili suggest (same fallback as Chrome).
    if (!ready) {
      setPending(false);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPending(true);
      fetchSuggest(term, { limit, signal: controller.signal, lang, printLang })
        .then((data) => {
          if (controller.signal.aborted) return;
          rememberSuggestGroups(data.groups);
          setLiveTick((tick) => tick + 1);
        })
        .catch(() => {})
        .finally(() => {
          if (!controller.signal.aborted) setPending(false);
        });
    }, 120);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, lang, printLang, kind, enabled, limit]);

  const ready = enabled && suggestLiveReady(query);
  const results = useMemo(() => {
    if (!ready) return [];
    const groups = liveSuggestGroups(query, { printLang, searchLang: lang, kind }).groups;
    return flattenPickable(groups).slice(0, limit);
    // liveTick forces re-read after Meili / catalog hydration
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, printLang, lang, kind, ready, liveTick, limit]);

  return { results, pending, ready };
}
