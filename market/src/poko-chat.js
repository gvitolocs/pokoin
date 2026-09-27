/** Reserved peer for the Poko assistant in Messages / chat dock. */
export const POKO_PEER = 'poko';
export const POKO_DISPLAY = 'Poko';
export const POKO_LEDE = 'Pokoin market assistant';

export function isPokoPeer(value) {
  return String(value || '').trim().toLowerCase() === POKO_PEER;
}

const HISTORY_PREFIX = 'pokoin.pokoChat.';

export function readPokoHistory(uid) {
  if (!uid) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(`${HISTORY_PREFIX}${uid}`) || '[]');
    return Array.isArray(raw) ? raw.slice(-80) : [];
  } catch (_) {
    return [];
  }
}

export function writePokoHistory(uid, events) {
  if (!uid) return;
  try {
    localStorage.setItem(`${HISTORY_PREFIX}${uid}`, JSON.stringify((events || []).slice(-80)));
  } catch (_) {
    /* private mode */
  }
}

export function pokoPreview(events = []) {
  const last = [...events].reverse().find((row) => row?.text || (row?.listings || row?.cards || []).length || (row?.images || []).length);
  if (!last) return 'Ask about cards, prices, and liquidity';
  if (last.text) return last.text;
  if ((last.images || []).length) return 'Photo attached';
  const card = (last.listings || last.cards || [])[0];
  return card?.cardName || card?.name || 'Card attached';
}

/** Map dock / chat listing tags into the poko-chat BFF card shape. */
export function tagsToPokoCards(tags = []) {
  return (Array.isArray(tags) ? tags : []).slice(0, 8).map((row) => ({
    cardId: String(row?.cardId || row?.id || ''),
    name: String(row?.cardName || row?.name || ''),
    setName: String(row?.setName || row?.set || ''),
    condition: String(row?.condition || ''),
    language: String(row?.language || ''),
    canonicalPath: String(row?.canonicalPath || row?.href || ''),
    imageUrl: String(row?.imageUrl || row?.cardImageUrl || ''),
  })).filter((row) => row.cardId || row.name);
}

export function cleanPokoImages(urls = []) {
  return (Array.isArray(urls) ? urls : [])
    .map((url) => String(url || '').trim())
    .filter((url) => /^https?:\/\//i.test(url))
    .slice(0, 8);
}
