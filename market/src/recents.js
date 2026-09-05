import { Timestamp, doc, getDoc, setDoc } from 'firebase/firestore';
import { firebaseAuth, firestore } from './auth.jsx';

const RECENT_KEY = 'pokoin.recentCardIds';
const RECENT_MAX = 24;
const FIRESTORE_MAX = 60;

function asId(value) {
  return String(value || '').trim();
}

export function readRecentCardIds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map(asId).filter((id) => /^\d+$/.test(id));
  } catch (_) {
    return [];
  }
}

function writeLocalIds(ids) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, RECENT_MAX)));
}

function mergeIds(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const raw of list || []) {
      const id = asId(raw);
      if (!/^\d+$/.test(id) || seen.has(id)) {
        continue;
      }
      seen.add(id);
      out.push(id);
      if (out.length >= RECENT_MAX) {
        return out;
      }
    }
  }
  return out;
}

function stubCard(card, id) {
  const viewedAt = Timestamp.now();
  return {
    cardId: id,
    name: String(card?.name || ''),
    expansion: String(card?.set || card?.set_name || ''),
    number: String(card?.number || card?.card_number || ''),
    imageUrl: String(card?.imageUrl || card?.heroImageUrl || card?.gridImageUrl || ''),
    previewImageUrl: String(card?.gridImageUrl || card?.imageUrl || ''),
    homepageImageUrl: String(card?.tileImageUrl || card?.gridImageUrl || card?.imageUrl || ''),
    viewedAt,
    itemKind: String(card?.itemKind || 'single'),
    productType: String(card?.productType || 'card'),
    canonicalPath: String(card?.canonicalPath || card?.canonical_path || ''),
    publicNumber: String(card?.number || ''),
    available: Boolean(card?.isMarketAvailable || card?.inStock),
    inStock: Boolean(card?.inStock || card?.isMarketAvailable),
    listingCount: 0,
    listedQuantity: 0,
    emoji: '',
    cardPalette: {},
  };
}

async function readFirebaseRecent() {
  const uid = firebaseAuth.currentUser?.uid;
  if (!uid) {
    return { ids: [], cards: [] };
  }
  const snap = await getDoc(doc(firestore, 'user_card_recent_views', uid));
  const data = snap.data() || {};
  const ids = (Array.isArray(data.cardIds) ? data.cardIds : []).map(asId).filter((id) => /^\d+$/.test(id));
  const cards = Array.isArray(data.cards) ? data.cards : [];
  return { ids, cards };
}

async function writeFirebaseRecent(ids, existingCards = [], extraCard = null) {
  const uid = firebaseAuth.currentUser?.uid;
  if (!uid) {
    return;
  }
  const limited = ids.slice(0, FIRESTORE_MAX);
  const byId = new Map();
  for (const row of existingCards) {
    const id = asId(row?.cardId || row?.id);
    if (id) {
      byId.set(id, row);
    }
  }
  if (extraCard) {
    const id = asId(extraCard.id || extraCard.card_id);
    if (id) {
      byId.set(id, stubCard(extraCard, id));
    }
  }
  const cards = limited.map((id) => byId.get(id) || stubCard(null, id));
  await setDoc(
    doc(firestore, 'user_card_recent_views', uid),
    {
      cardIds: limited,
      cards,
      updatedAt: Timestamp.now(),
      expiresAt: Timestamp.fromDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)),
    },
    { merge: true },
  );
}

export async function loadRecentCardIds() {
  return syncRemoteRecentCardIds();
}

/** Firestore merge. Do not call on the home LCP path — localStorage is enough to paint. */
export async function syncRemoteRecentCardIds() {
  const local = readRecentCardIds();
  try {
    const remote = await readFirebaseRecent();
    const merged = mergeIds(local, remote.ids);
    if (firebaseAuth.currentUser && merged.length) {
      writeLocalIds(merged);
      if (merged.join(',') !== remote.ids.slice(0, RECENT_MAX).join(',')) {
        void writeFirebaseRecent(merged, remote.cards);
      }
    }
    return merged;
  } catch (_) {
    return local;
  }
}

export function rememberCardId(cardOrId) {
  const card = cardOrId && typeof cardOrId === 'object' ? cardOrId : null;
  const id = asId(card?.id || card?.card_id || cardOrId);
  if (!/^\d+$/.test(id)) {
    return;
  }
  const next = mergeIds([id], readRecentCardIds());
  writeLocalIds(next);
  if (!firebaseAuth.currentUser) {
    return;
  }
  void readFirebaseRecent()
    .then((remote) => writeFirebaseRecent(mergeIds([id], remote.ids, next), remote.cards, card))
    .catch(() => {});
}
