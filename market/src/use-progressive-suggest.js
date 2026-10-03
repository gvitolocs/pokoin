import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchSuggest } from './api.js';
import { isPokemonGame } from './game.js';
import {
  buildScope,
  chunkSize,
  consumePage,
  createGenerationClock,
  emptyPool,
  filterCandidates,
  paintSource,
  projectPoolGroups,
  reuseDecision,
  shouldContinue,
  FIRST_CHUNK,
} from './suggest-pool.js';
import { compactQuery, rankNames } from './suggest-rank.js';

function compactLengthOfQuery(query) {
  return compactQuery(query).length;
}

/**
 * Keystroke paints from the pool already in memory. The network chunk for
 * this generation arrives later and may only merge if it is still current.
 */
export function useProgressiveSuggest({
  query,
  lang,
  printLang,
  kind = 'singles',
  game,
  enabled = true,
  limit = 20,
  onPage,
} = {}) {
  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;
  const pool = useRef(emptyPool());
  const clock = useRef(createGenerationClock());
  const [epoch, setEpoch] = useState(0);
  const [pending, setPending] = useState(false);
  const [nameRank, setNameRank] = useState(null);
  const [nameRankQuery, setNameRankQuery] = useState('');
  const scope = buildScope({
    lang,
    printLang,
    kind,
    game: game || (isPokemonGame() ? 'pokemon' : 'other'),
    query,
  });
  const source = paintSource(pool.current, query, scope);

  const groups = useMemo(() => {
    if (!enabled) return null;
    const started = typeof performance !== 'undefined' ? performance.now() : 0;
    const ranked = nameRankQuery === query ? nameRank : null;
    const next = projectPoolGroups(query, source.rows, { limit, kind, printLang, ranked });
    pool.current.lastLocalMs = started ? performance.now() - started : 0;
    return next;
  }, [query, source.rows, limit, kind, printLang, enabled, nameRank, nameRankQuery]);

  useEffect(() => {
    if (!enabled || !String(query || '').trim()) {
      setNameRank(null);
      setNameRankQuery('');
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const ranked = rankNames(query);
      if (cancelled) return;
      setNameRank(ranked);
      setNameRankQuery(query);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, enabled]);

  useEffect(() => {
    if (!enabled) {
      setPending(false);
      return undefined;
    }
    const term = String(query || '').trim();
    const nextScope = buildScope({
      lang,
      printLang,
      kind,
      game: game || (isPokemonGame() ? 'pokemon' : 'other'),
      query: term,
    });
    const decision = reuseDecision(pool.current.query, term, pool.current.scope, nextScope);
    const generation = clock.current.next();
    pool.current.generation = generation;
    pool.current.scope = nextScope;
    pool.current.query = term;
    if (decision.action === 'reset') {
      pool.current.rows = [];
    }
    if (!term) {
      setPending(false);
      setEpoch((value) => value + 1);
      return undefined;
    }

    const controller = new AbortController();
    let stopped = false;
    setPending(true);
    (async () => {
      let offset = 0;
      let chunks = 0;
      let fetched = 0;
      while (!stopped && pool.current.generation === generation) {
        const size = chunkSize(chunks);
        let page;
        try {
          page = await fetchSuggest(term, {
            limit: size,
            offset,
            progressive: true,
            hydrate: true,
            signal: controller.signal,
            lang,
            printLang,
          });
        } catch (error) {
          if (error?.name === 'AbortError') pool.current.cancelled += 1;
          return;
        }
        if (stopped || pool.current.generation !== generation) {
          pool.current.stale += 1;
          return;
        }
        const applied = consumePage(pool.current, generation, page);
        if (!applied.applied) return;
        onPageRef.current?.(page);
        fetched += applied.incoming || 0;
        chunks += 1;
        offset = Number.isFinite(Number(page?.nextOffset))
          ? Number(page.nextOffset)
          : offset + (applied.incoming || 0);
        setEpoch((value) => value + 1);
        const visible = filterCandidates(pool.current.rows, term).length;
        const total = Number(page?.globalCount || page?.count || 0) || 0;
        const exhaustive = page?.exhaustive === true || (applied.incoming || 0) < size;
        if (!shouldContinue({
          compactLength: compactLengthOfQuery(term),
          fetched,
          chunkHits: applied.incoming || 0,
          estimatedTotal: total,
          chunks,
          exhaustive,
          visibleRows: visible,
        })) {
          break;
        }
      }
    })().finally(() => {
      if (!stopped && pool.current.generation === generation) setPending(false);
    });

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [query, lang, printLang, kind, game, enabled, limit]);

  return {
    groups: groups || [],
    projected: source.rows.length > 0,
    pending,
    epoch,
    poolSize: pool.current.rows.length,
    transferred: pool.current.transferred,
    stale: pool.current.stale,
    cancelled: pool.current.cancelled,
    localMs: pool.current.lastLocalMs || 0,
    firstChunk: FIRST_CHUNK,
  };
}
