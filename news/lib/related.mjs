// Related-story scoring over published article records.

function entitySets(record) {
  const ids = new Set();
  const names = new Set();
  for (const entity of record.entities || []) {
    if (!entity || typeof entity !== 'object') continue;
    if (entity.resolved && entity.pokoinId !== undefined && entity.pokoinId !== null) {
      ids.add(String(entity.pokoinId));
    }
    if (entity.name) names.add(String(entity.name).toLowerCase());
  }
  return { ids, names };
}

function sharedCount(a, b) {
  let count = 0;
  for (const value of a) if (b.has(value)) count += 1;
  return count;
}

function isPublished(record) {
  return record && record.status === 'published';
}

export function relatedStories(record, all, limit = 4) {
  if (!record || !Array.isArray(all)) return [];
  const own = entitySets(record);
  const ownTags = new Set((record.tags || []).map((tag) => String(tag).toLowerCase()));

  const scored = [];
  for (const candidate of all) {
    if (!isPublished(candidate) || candidate === record || candidate.slug === record.slug) continue;
    const other = entitySets(candidate);
    const otherTags = new Set((candidate.tags || []).map((tag) => String(tag).toLowerCase()));
    const score =
      3 * sharedCount(own.ids, other.ids) +
      2 * sharedCount(own.names, other.names) +
      1 * sharedCount(ownTags, otherTags) +
      (candidate.section === record.section ? 1 : 0);
    if (score > 0) scored.push({ record: candidate, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.record.datePublished || 0).getTime() - new Date(a.record.datePublished || 0).getTime();
  });

  return scored.slice(0, limit).map((entry) => entry.record);
}

export function entityIndex(all) {
  const index = new Map();
  for (const record of all || []) {
    if (!record || !Array.isArray(record.entities)) continue;
    for (const entity of record.entities) {
      if (!entity || !entity.name) continue;
      const key = entity.pokoinId !== undefined && entity.pokoinId !== null
        ? `pokoin:${entity.pokoinId}`
        : `name:${String(entity.name).toLowerCase()}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(record);
    }
  }
  return index;
}
