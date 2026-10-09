/**
 * Singles search over the header popup's recall lookups. The popup ranks the
 * printings of `catalogRecall(query)` (the full query plus its name stem, or
 * the closest names for a typo) and counts that union, so "View all N" has to
 * open the same N rows: set-aware rows first (when the page resolved a set),
 * then every lookup's printings not shown yet, in lookup order. The union is
 * paged like one search: offset / limit / nextOffset / hasMore / total.
 */

/** Full query first, then the recall names, unique by compact form, at most `max`. */
export function recallOrder(query, names, compact, max = 4) {
  const out = [];
  const seen = new Set();
  for (const value of [query, ...(names || [])]) {
    const text = String(value || '').trim();
    const key = compact(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function cardKey(card) {
  return String(card?.id ?? card?.card_id ?? card?.cardId ?? '');
}

function nextOffsetOf(page, offset) {
  const next = Number(page?.nextOffset);
  return Number.isFinite(next) ? next : offset + (page?.cards || []).length;
}

export function createRecallSearch({
  fetchSearchPage,
  recallLookups,
  isRecallRequest = () => true,
  pageSize = 96,
  maxPages = 80,
  maxSessions = 8,
  ttlMs = 120_000,
  now = Date.now,
} = {}) {
  const sessions = new Map();

  function sessionFor(key) {
    const hit = sessions.get(key);
    if (hit && now() - hit.at < ttlMs) return hit;
    const fresh = {
      at: now(),
      rows: [],
      ids: new Set(),
      lookups: null,
      buffered: [],
      offsets: [],
      more: [],
      totals: [],
      headTotal: 0,
      cursor: 0,
      pages: 0,
      done: false,
      base: null,
      queue: Promise.resolve(),
    };
    sessions.delete(key);
    sessions.set(key, fresh);
    while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
    return fresh;
  }

  function absorb(session, cards) {
    for (const card of cards || []) {
      const id = cardKey(card);
      if (id && session.ids.has(id)) continue;
      if (id) session.ids.add(id);
      session.rows.push(card);
    }
  }

  async function start(session, options, request) {
    const [lookups, headRows] = await Promise.all([
      recallLookups(options.query),
      typeof options.head === 'function' ? options.head() : null,
    ]);
    const firsts = await Promise.all(lookups.map((query) => fetchSearchPage({
      ...request, query, offset: 0, limit: pageSize,
    })));
    session.lookups = lookups;
    session.base = firsts[0] || {};
    firsts.forEach((page, index) => {
      session.buffered[index] = page;
      session.totals[index] = Number(page?.total) || 0;
      session.offsets[index] = nextOffsetOf(page, 0);
      session.more[index] = Boolean(page?.hasMore) && (page?.cards || []).length > 0;
    });
    session.pages += firsts.length;
    if (Array.isArray(headRows)) {
      absorb(session, headRows);
      session.headTotal = session.rows.length;
    }
  }

  async function fill(session, want, request) {
    while (session.rows.length < want && !session.done) {
      const index = session.cursor;
      if (index >= session.lookups.length || session.pages >= maxPages) {
        session.done = true;
        break;
      }
      let page = session.buffered[index];
      if (page) {
        session.buffered[index] = null;
      } else if (session.more[index]) {
        const offset = session.offsets[index];
        page = await fetchSearchPage({ ...request, query: session.lookups[index], offset, limit: pageSize });
        session.pages += 1;
        session.offsets[index] = nextOffsetOf(page, offset);
        session.more[index] = Boolean(page?.hasMore) && (page?.cards || []).length > 0;
      }
      if (page) absorb(session, page.cards);
      if (!session.buffered[index] && !session.more[index]) session.cursor += 1;
    }
  }

  return async function fetchSearchRecall(options = {}) {
    const { head, ...request } = options;
    if (!isRecallRequest(request)) return fetchSearchPage(request);
    const offset = Math.max(0, Number(request.offset) || 0);
    const limit = Math.max(1, Number(request.limit) || 48);
    const key = JSON.stringify([
      String(request.query || '').trim(), request.lang || '', request.productType || '',
      Boolean(request.productSearchOnly), typeof head === 'function',
    ]);
    const session = sessionFor(key);
    // One request at a time per session: the header prefetch and the page share it.
    const run = session.queue.then(async () => {
      if (!session.lookups) await start(session, options, request);
      await fill(session, offset + limit + 1, request);
      const cards = session.rows.slice(offset, offset + limit);
      const known = Math.max(session.headTotal, ...session.totals, 0);
      const total = session.done ? session.rows.length : Math.max(known, session.rows.length);
      return {
        ...session.base,
        query: String(request.query || '').trim(),
        offset,
        limit,
        cards,
        count: cards.length,
        total,
        hasMore: session.rows.length > offset + limit || !session.done,
        nextOffset: offset + cards.length,
        recall: session.lookups,
      };
    });
    session.queue = run.catch(() => {});
    try {
      return await run;
    } catch (error) {
      // A failed or aborted page must not poison the next caller's session.
      sessions.delete(key);
      throw error;
    }
  };
}
