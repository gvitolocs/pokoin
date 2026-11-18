/** The wallet request id — the name one money intent carries to the server.
 *
 * The API applies a request id once, so a Send whose answer never arrived is
 * sent again under the id of that intent instead of becoming another one. A
 * different intent, and the same intent once it has landed, carry a new id. */

/** A new intent's id: the v4 UUID text the wallet API accepts. */
export function newRequestId() {
  const minted = globalThis.crypto?.randomUUID?.();
  if (minted) {
    return minted;
  }
  // A page served outside a secure context has no randomUUID; its wallet still
  // names every intent it sends.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
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
