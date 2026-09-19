/** Local username hints for the Send sheet (from Activity titles). */

const COUNTERPARTY_RE = /\b(?:to|from)\s+([a-z0-9]{3,32})\b/i;

/** Pull counterparties out of activity titles like "Sent 5 PKN to ash". */
export function counterpartiesFromActivity(rows = []) {
  const names = [];
  const seen = new Set();
  for (const row of rows || []) {
    const match = COUNTERPARTY_RE.exec(String(row?.title || ''));
    const name = String(match?.[1] || '').trim().toLowerCase();
    if (!name || seen.has(name) || !/^[a-z0-9]{3,32}$/.test(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Prefix-filter local + remote usernames; keep order, drop self/dupes. */
export function mergeUsernameSuggestions({
  query = '',
  local = [],
  remote = [],
  selfUsername = '',
  limit = 6,
} = {}) {
  const prefix = String(query || '').trim().toLowerCase();
  if (prefix.length < 1) return [];
  const self = String(selfUsername || '').trim().toLowerCase();
  const out = [];
  const seen = new Set();
  for (const raw of [...local, ...remote]) {
    const name = String(raw || '').trim().toLowerCase();
    if (!name || seen.has(name) || name === self) continue;
    if (!name.startsWith(prefix)) continue;
    if (!/^[a-z0-9]{3,32}$/.test(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}
