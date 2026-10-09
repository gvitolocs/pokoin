/**
 * Same typeahead engine as the header search bar (Chrome.jsx):
 * liveSuggestGroups paint + fetchSuggestRanked Meili hydration.
 * docs/TYPEAHEAD.md
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchArtist,
  fetchExpansionCards,
  fetchNamePrintings,
  fetchSuggest,
  imageSrc,
} from './api.js';
import { isPokemonGame } from './game.js';
import { usePrintLang, useSearchLang } from './locale-hooks.js';
import { cardsWithCatalogArtist, catalogCacheKey, catalogIntent, groupsFromCards } from './suggest-catalog.js';
import {
  collectPrintingThumbUrls,
  preloadSuggestThumbs,
} from './suggest-images.js';
import {
  cachedPrintings,
  isLiveStub,
  paintCatalogGroups,
  rememberPrintings,
  rememberSuggestGroups,
  suggestLiveReady,
} from './suggest-live.js';
import { warmupSuggestRankWorkers } from './suggest-rank-runtime.js';
import { useProgressiveSuggest } from './use-progressive-suggest.js';
import { resolveSuggestQuery } from './suggest-resolve.js';
import { earlySetPrefixName } from './search-score.js';

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
  const progressive = useProgressiveSuggest({
    query,
    lang,
    printLang,
    kind,
    enabled: enabled && isPokemonGame(),
    limit,
  });
  const queryRef = useRef('');

  useEffect(() => {
    warmupSuggestRankWorkers();
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const term = String(query || '').trim();
    queryRef.current = term;
    if (!term) {
      setPending(false);
      return undefined;
    }

    const ready = suggestLiveReady(term);
    const resolvedOnce = resolveSuggestQuery(term);

    function hydrateCatalog(nextTerm, resolved) {
      const targets = [];
      const prefixName = earlySetPrefixName(nextTerm, { lang });
      if (prefixName) {
        targets.push({ key: `prefix-name:${lang}:${prefixName}`, kind: 'name', name: prefixName });
      }
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
        if (target.kind === 'name') {
          fetchNamePrintings(target.name, { lang })
            .then((cards) => {
              rememberPrintings(target.key, cards);
              preloadSuggestThumbs(collectPrintingThumbUrls(groupsFromCards(cards), suggestThumbSrc));
              if (suggestLiveReady(String(queryRef.current || '').trim())) {
                setLiveTick((tick) => tick + 1);
              }
            })
            .catch(() => {});
          continue;
        }
        if (target.kind === 'artist') {
          fetchArtist(target.slug, { limit: 80 })
            .then((data) => {
              const cards = cardsWithCatalogArtist(data);
              rememberPrintings(target.key, cards);
              rememberSuggestGroups(groupsFromCards(cards));
              preloadSuggestThumbs(collectPrintingThumbUrls(groupsFromCards(cards), suggestThumbSrc));
              if (suggestLiveReady(String(queryRef.current || '').trim())) {
                setLiveTick((tick) => tick + 1);
              }
            })
            .catch(() => {});
          continue;
        }
        // Keep add-card search in parity with the header: later set pages
        // contribute candidates to the same scorer, rather than disappearing.
        fetchExpansionCards({ slug: target.slug })
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
      return undefined;
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
    const groups = progressive.projected
      ? progressive.groups
      : paintCatalogGroups(query, { printLang, searchLang: lang, kind, limit });
    return flattenPickable(groups).slice(0, limit);
    // liveTick forces re-read after Meili / catalog hydration
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, printLang, lang, kind, ready, liveTick, limit, progressive.projected, progressive.groups, progressive.epoch]);

  return {
    results,
    pending: isPokemonGame() ? progressive.pending : pending,
    ready,
  };
}
