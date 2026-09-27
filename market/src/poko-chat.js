/** Reserved peer for the Poko assistant in Messages. */
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
  const last = [...events].reverse().find((row) => row?.text);
  return last?.text || 'Ask about cards, prices, and liquidity';
}
