import { getBearer } from './auth.jsx';
import { publicApiUrl } from './extension-auth-bridge.js';
import { game as currentGame, gameRequestHeaders, withGameQuery } from './game.js';
import {
  RECENT_MAX,
  clearLegacyUnscopedRecents,
  forgetLocalCardId,
  mergeRecentIds,
  readRecentCardIds,
  rememberLocalCardId,
  replaceLocalRecentIds,
  writeLocalIds,
} from './recents-storage.js';

export {
  RECENT_MAX,
  clearLegacyUnscopedRecents,
  compactRecentTile,
  forgetLocalCardId,
  peekRecentTile,
  readRecentCardIds,
  readRecentTiles,
  rememberRecentTiles,
  recentIdsKey,
  recentTilesKey,
  replaceLocalRecentIds,
} from './recents-storage.js';

let remoteWriteTimer = 0;
let legacyCleared = false;

function resolveGameId(gameId) {
  return String(gameId || currentGame().id || 'pokemon').trim() || 'pokemon';
}

function ensureLegacyCleared() {
  if (legacyCleared) {
    return;
  }
  legacyCleared = true;
  clearLegacyUnscopedRecents();
}

function recentsUrl(gameId, path = '/api/marketplace-recents') {
  const resolved = resolveGameId(gameId);
  const withGame = withGameQuery(path);
  if (/[?&]game=/.test(withGame)) {
    return publicApiUrl(withGame);
  }
  const join = withGame.includes('?') ? '&' : '?';
  return publicApiUrl(`${withGame}${join}game=${encodeURIComponent(resolved)}`);
}

async function fetchRemoteRecentIds(token, gameId) {
  const resolved = resolveGameId(gameId);
  const res = await fetch(recentsUrl(resolved), {
    headers: {
      Authorization: `Bearer ${token}`,
      ...gameRequestHeaders(),
    },
  });
  if (!res.ok) {
    return null;
  }
  const body = await res.json().catch(() => ({}));
  return mergeRecentIds(body.cardIds || body.card_ids || []);
}

async function putRemoteRecentIds(token, ids, gameId) {
  const resolved = resolveGameId(gameId);
  const res = await fetch(recentsUrl(resolved), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...gameRequestHeaders(),
    },
    body: JSON.stringify({
      game: resolved,
      cardIds: ids.slice(0, RECENT_MAX),
    }),
    keepalive: true,
  });
  return res;
}

async function postRemoteRecentCard(token, cardId, gameId) {
  const resolved = resolveGameId(gameId);
  return fetch(recentsUrl(resolved), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...gameRequestHeaders(),
    },
    body: JSON.stringify({
      game: resolved,
      cardId,
    }),
    keepalive: true,
  });
}

function scheduleRemoteWrite(ids, gameId) {
  const resolved = resolveGameId(gameId);
  globalThis.clearTimeout(remoteWriteTimer);
  remoteWriteTimer = globalThis.setTimeout(() => {
    void getBearer()
      .then((token) => (token ? putRemoteRecentIds(token, ids, resolved) : null))
      .catch(() => {});
  }, 250);
}

function scheduleRemoteCard(cardId, gameId) {
  const resolved = resolveGameId(gameId);
  const id = String(cardId || '').trim();
  if (!/^\d+$/.test(id)) {
    return;
  }
  globalThis.clearTimeout(remoteWriteTimer);
  remoteWriteTimer = globalThis.setTimeout(() => {
    void getBearer()
      .then(async (token) => {
        if (!token) {
          return;
        }
        const res = await postRemoteRecentCard(token, id, resolved);
        if (!res || res.ok) {
          return;
        }
        // Wrong-game or unknown card: do not keep it in this storefront's history.
        if (res.status === 400) {
          forgetLocalCardId(id, resolved);
        }
      })
      .catch(() => {});
  }, 250);
}

export async function loadRecentCardIds(gameId) {
  return syncRemoteRecentCardIds(gameId);
}

/** Account recents after auth. Do not call on the home LCP path. */
export async function syncRemoteRecentCardIds(gameId) {
  ensureLegacyCleared();
  const resolved = resolveGameId(gameId);
  const local = readRecentCardIds(resolved);
  try {
    const token = await getBearer();
    if (!token) {
      return local;
    }
    const remote = await fetchRemoteRecentIds(token, resolved);
    if (!remote) {
      return local;
    }
    // Server game row is authoritative. Do not re-upload polluted local cross-game ids.
    replaceLocalRecentIds(remote, resolved);
    return remote;
  } catch {
    return local;
  }
}

/**
 * Drop recent ids that did not resolve in this game's catalog/tiles.
 * Keeps disposable local history honest after a failed hydrate.
 */
export function pruneUnresolvedRecents(resolvedIds, gameId) {
  ensureLegacyCleared();
  const resolved = resolveGameId(gameId);
  const keep = new Set((resolvedIds || []).map((id) => String(id)));
  const current = readRecentCardIds(resolved);
  const next = current.filter((id) => keep.has(String(id)));
  if (next.join(',') !== current.join(',')) {
    replaceLocalRecentIds(next, resolved);
  }
  return next;
}

export function rememberCardId(cardOrId, gameId) {
  ensureLegacyCleared();
  const resolved = resolveGameId(gameId);
  const card = cardOrId && typeof cardOrId === 'object' ? cardOrId : null;
  const id = String(card?.id || card?.card_id || card?.cardId || cardOrId || '').trim();
  const next = rememberLocalCardId(cardOrId, resolved);
  if (!next.length) {
    return;
  }
  if (/^\d+$/.test(id)) {
    scheduleRemoteCard(id, resolved);
    return;
  }
  scheduleRemoteWrite(next, resolved);
}
