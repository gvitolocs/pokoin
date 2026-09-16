import { doc, getDoc } from 'firebase/firestore';
import { firebaseAuth, firestore, getBearer } from './auth.jsx';
import { framedByChromeExtension, publicApiUrl } from './extension-auth-bridge.js';
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
} from './recents-storage.js';

let remoteWriteTimer = 0;

async function readFirestoreRecentIds() {
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

async function fetchRemoteRecentIds(token) {
  const res = await fetch(publicApiUrl('/api/marketplace-recents'), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    return [];
  }
  const body = await res.json().catch(() => ({}));
  return mergeRecentIds(body.cardIds || body.card_ids || []);
}

async function putRemoteRecentIds(token, ids) {
  await fetch(publicApiUrl('/api/marketplace-recents'), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ cardIds: ids.slice(0, RECENT_MAX) }),
    keepalive: true,
  });
}

function scheduleRemoteWrite(ids) {
  globalThis.clearTimeout(remoteWriteTimer);
  remoteWriteTimer = globalThis.setTimeout(() => {
    void getBearer()
      .then((token) => (token ? putRemoteRecentIds(token, ids) : null))
      .catch(() => {});
  }, 250);
}

export async function loadRecentCardIds() {
  return syncRemoteRecentCardIds();
}

/** Account recents after auth. Do not call on the home LCP path. */
export async function syncRemoteRecentCardIds() {
  const local = readRecentCardIds();
  try {
    const token = await getBearer();
    if (!token) {
      return local;
    }
    const [remote, legacy] = await Promise.all([
      fetchRemoteRecentIds(token),
      readFirestoreRecentIds().catch(() => []),
    ]);
    const merged = mergeRecentIds(local, remote, legacy);
    writeLocalIds(merged);
    if (merged.join(',') !== remote.join(',')) {
      await putRemoteRecentIds(token, merged).catch(() => {});
    }
    return merged;
  } catch {
    return local;
  }
}

export function rememberCardId(cardOrId) {
  const next = rememberLocalCardId(cardOrId);
  if (next.length) {
    scheduleRemoteWrite(next);
  }
}
