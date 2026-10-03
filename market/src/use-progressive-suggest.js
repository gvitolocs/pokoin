import { useEffect, useRef, useState } from 'react';
import { fetchSuggest } from './api.js';
import { isPokemonGame } from './game.js';
import { rememberSuggestGroups } from './suggest-live.js';
import {
  buildScope,
  catalogRecall,
  chunkSize,
  createGenerationClock,
  emptyPool,
  reuseDecision,
  FIRST_CHUNK,
  MAX_CHUNKS,
  SAFETY_BUDGET,
} from './suggest-pool.js';
import { compactQuery } from './suggest-rank.js';

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
    const lookups = catalogRecall(term);
    (async () => {
      for (const lookup of lookups) {
        if (stopped || pool.current.generation !== generation) return;
        let offset = 0;
        let chunks = 0;
        let fetched = 0;
        const compactLength = compactQuery(lookup).length;
        while (!stopped && pool.current.generation === generation) {
          const size = chunkSize(chunks);
          let page;
          try {
            page = await fetchSuggest(lookup, {
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
          rememberSuggestGroups(page?.groups, { searchLang: lang });
          const incoming = (page?.groups || []).reduce(
            (sum, group) => sum + (group.printings || []).length,
            0,
          );
          pool.current.transferred += incoming;
          onPageRef.current?.(page);
          fetched += incoming;
          chunks += 1;
          offset = Number.isFinite(Number(page?.nextOffset))
            ? Number(page.nextOffset)
            : offset + incoming;
          setEpoch((value) => value + 1);
          const exhaustive = page?.exhaustive === true || incoming < size;
          if (exhaustive || incoming === 0) break;
          if (fetched >= SAFETY_BUDGET || chunks >= MAX_CHUNKS) break;
          // One letter prefetches a page. A real name keeps paging its printings.
          if (compactLength <= 2) break;
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
    groups: [],
    projected: false,
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
