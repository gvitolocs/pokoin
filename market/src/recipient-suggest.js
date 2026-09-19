/** Local username hints for the Send sheet (from Activity titles). */

const COUNTERPARTY_RE = /\b(?:to|from)\s+([a-z0-9]{3,32})\b/i;

export function compactRecipientQuery(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Pull counterparties out of activity titles like "Sent 5 PKN to ash". */
export function counterpartiesFromActivity(rows = []) {
  const names = [];
  const seen = new Set();
  for (const row of rows || []) {
    const match = COUNTERPARTY_RE.exec(String(row?.title || ''));
    const name = String(match?.[1] || '').trim().toLowerCase();
    if (!name || seen.has(name) || !/^[a-z0-9]{3,32}$/.test(name)) continue;
    seen.add(name);
    names.push({ username: name, displayName: '' });
  }
  return names;
}

function asSuggestion(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const username = raw.trim().toLowerCase();
    return username ? { username, displayName: '' } : null;
  }
  const username = String(raw.username || '').trim().toLowerCase();
  if (!username) return null;
  const displayName = String(raw.displayName || '').trim();
  return {
    username,
    displayName: displayName && displayName.toLowerCase() !== username ? displayName : '',
  };
}

/** Prefix-filter local + remote usernames; keep order, drop self/dupes. */
export function mergeUsernameSuggestions({
  query = '',
  local = [],
  remote = [],
  selfUsername = '',
  limit = 6,
} = {}) {
  const prefix = compactRecipientQuery(query);
  if (prefix.length < 1) return [];
  const self = String(selfUsername || '').trim().toLowerCase();
  const out = [];
  const seen = new Set();
  for (const raw of [...local, ...remote]) {
    const row = asSuggestion(raw);
    if (!row || seen.has(row.username) || row.username === self) continue;
    const compactDisplay = compactRecipientQuery(row.displayName);
    if (!(row.username.startsWith(prefix) || (compactDisplay && compactDisplay.startsWith(prefix)))) {
      continue;
    }
    if (!/^[a-z0-9]{3,32}$/.test(row.username)) continue;
    seen.add(row.username);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}
