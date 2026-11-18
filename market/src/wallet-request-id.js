/** The wallet request id — the name one money intent carries to the server.
 *
 * The API applies a request id once, so a Send that is pressed again while its
 * intent is still the one it holds carries the id that intent already had.
 * The holder keeps one intent for one mount: a changed intent, a press after a
 * landing, a reload or a new mount gives a new id, and the request it names. */

/** A new intent's id: the v4 UUID text the wallet API accepts. */
export function newRequestId() {
  const minted = globalThis.crypto?.randomUUID?.();
  if (minted) {
    return minted;
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    // A page served outside a secure context has no randomUUID; its wallet
    // still names every intent it sends.
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // No Web Crypto here either, so the id is drawn from Math.random: one per
    // intent, which is all an id that names an intent has to be.
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** What one press asks for: who or where, and how much. Either changing makes
 * it another intent. */
export function walletIntent(kind, target, amountPkn) {
  const amount = Math.round(Number(amountPkn) || 0);
  return `${kind}|${String(target || '').trim().toLowerCase()}|${amount}`;
}

/** One request id per intent: `idFor(intent)` keeps the id of an intent that is
 * sent again, and mints one when the intent is new. */
export function createRequestIds(newId = newRequestId) {
  let intent = null;
  let requestId = null;
  return {
    idFor(nextIntent) {
      if (nextIntent !== intent || !requestId) {
        intent = nextIntent;
        requestId = newId();
      }
      return requestId;
    },
    /** The intent landed: its id is spent, so the next press names a new one. */
    settle() {
      intent = null;
      requestId = null;
    },
  };
}
