import { doc, getDoc } from 'firebase/firestore';
import { firebaseAuth, firestore, getBearer } from './auth.jsx';
import { framedByChromeExtension, publicApiUrl } from './extension-auth-bridge.js';
import { game as currentGame, gameRequestHeaders, withGameQuery } from './game.js';
import {
  RECENT_MAX,
  mergeRecentIds,
  readRecentCardIds,
  rememberLocalCardId,
  writeLocalIds,
} from './recents-storage.js';

export {
  RECENT_MAX,
  compactRecentTile,
  peekRecentTile,
  readRecentCardIds,
  readRecentTiles,
  rememberRecentTiles,
  recentIdsKey,
  recentTilesKey,
} from './recents-storage.js';

let remoteWriteTimer = 0;

function resolveGameId(gameId) {
  return String(gameId || currentGame().id || 'pokemon').trim() || 'pokemon';
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

async function readFirestoreRecentIds(gameId) {
  // Legacy Firestore list was never game-scoped. Only seed pokemon.
  if (resolveGameId(gameId) !== 'pokemon') {
    return [];
  }
  if (framedByChromeExtension()) {
    return [];
  }
  const uid = firebaseAuth.currentUser?.uid;
  if (!uid) {
    return [];
  }
  const snap = await getDoc(doc(firestore, 'user_card_recent_views', uid));
  const data = snap.data() || {};
  return (Array.isArray(data.cardIds) ? data.cardIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d+$/.test(id));
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
    return [];
  }
  const body = await res.json().catch(() => ({}));
  return mergeRecentIds(body.cardIds || body.card_ids || []);
}

async function putRemoteRecentIds(token, ids, gameId) {
  const resolved = resolveGameId(gameId);
  await fetch(recentsUrl(resolved), {
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
}

async function postRemoteRecentCard(token, cardId, gameId) {
  const resolved = resolveGameId(gameId);
  await fetch(recentsUrl(resolved), {
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
      .then((token) => (token ? postRemoteRecentCard(token, id, resolved) : null))
      .catch(() => {});
  }, 250);
}

export async function loadRecentCardIds(gameId) {
  return syncRemoteRecentCardIds(gameId);
}

/** Account recents after auth. Do not call on the home LCP path. */
export async function syncRemoteRecentCardIds(gameId) {
  const resolved = resolveGameId(gameId);
  const local = readRecentCardIds(resolved);
  try {
    const token = await getBearer();
    if (!token) {
      return local;
    }
    const [remote, legacy] = await Promise.all([
      fetchRemoteRecentIds(token, resolved),
      readFirestoreRecentIds(resolved).catch(() => []),
    ]);
    const merged = mergeRecentIds(local, remote, legacy);
    writeLocalIds(merged, resolved);
    if (merged.join(',') !== remote.join(',')) {
      await putRemoteRecentIds(token, merged, resolved).catch(() => {});
    }
    return merged;
  } catch {
    return local;
  }
}

export function rememberCardId(cardOrId, gameId) {
  const resolved = resolveGameId(gameId);
  const card = cardOrId && typeof cardOrId === 'object' ? cardOrId : null;
  const id = String(card?.id || card?.card_id || card?.cardId || cardOrId || '').trim();
  const next = rememberLocalCardId(cardOrId, resolved);
  if (!next.length) {
    return;
  }
  // Prefer a single-card POST so other games' histories are never rewritten.
  if (/^\d+$/.test(id)) {
    scheduleRemoteCard(id, resolved);
    return;
  }
  scheduleRemoteWrite(next, resolved);
}
