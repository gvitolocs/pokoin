// /wallet data without a UI framework: the merged activity feed (ledger,
// wallet activity, chain txs) behind its localStorage cache, the recipient
// username search, and the payment-QR camera loop. Wallet.jsx (React) and
// the Solid wallet page both use these.

import jsQR from 'jsqr';
import { fetchChainAddressActivity, searchRecipientUsernames } from './api.js';
import { fetchOwnedCollectionDocuments } from './firestore-rest.js';
import { compactRecipientQuery } from './recipient-suggest.js';
import {
  activityFromChainTx,
  activityFromLedgerRow,
  activityFromWalletRow,
  mergeActivity,
} from './wallet-activity.js';
import {
  activityCacheIsFresh,
  activityFingerprint,
  activityNewestMs,
  readActivityCache,
  writeActivityCache,
} from './wallet-activity-cache.js';
import { parseScannedQr } from './wallet-qr.js';

/** Bank wallet that funds account top-ups (same treasury as cardvault). */
export const TREASURY_ADDRESS = '0xb4029F68E360280aa4Ad21D8aE5AD8896b8768B2';
export const ACTIVITY_ROW_COUNT = 12;
export const ACTIVITY_QUERY_LIMIT = 60;
export const IS_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Instant paint: the last successful feed for this uid (+ chain address), or null. */
export function cachedActivityRows(uid, address) {
  const cached = readActivityCache(uid, address);
  return cached?.rows?.length ? cached.rows : null;
}

/**
 * Refresh the feed. Returns the rows to show, or null when what is on screen
 * is already current. `onLoading(true)` fires only when there is nothing
 * cached to show meanwhile.
 */
export async function loadWalletActivity({ uid, address, getBearer, force = false, onLoading }) {
  const cached = readActivityCache(uid, address);
  if (!force && activityCacheIsFresh(cached)) {
    return cached.rows;
  }
  if (!(cached?.rows?.length || false)) onLoading?.(true);
  // Overlap one minute so clock skew / same-second writes are not missed.
  const sinceMs = !force && cached?.rows?.length
    ? Math.max(0, activityNewestMs(cached.rows) - 60_000)
    : 0;
  const groups = await Promise.allSettled([
    (async () => {
      const token = await getBearer();
      const rows = await fetchOwnedCollectionDocuments('ledger_entries', uid, token, {
        limit: ACTIVITY_QUERY_LIMIT,
        sinceMs,
      });
      return rows.map(activityFromLedgerRow);
    })(),
    (async () => {
      const token = await getBearer();
      const rows = await fetchOwnedCollectionDocuments('wallet_activity', uid, token, {
        limit: ACTIVITY_QUERY_LIMIT,
        sinceMs,
      });
      return rows.map(activityFromWalletRow);
    })(),
    (async () => {
      if (!address) return [];
      const txs = await fetchChainAddressActivity(address, { limit: ACTIVITY_QUERY_LIMIT });
      return txs.map((tx) => activityFromChainTx(tx, address));
    })(),
  ]);
  const fetched = groups.map((row) => (row.status === 'fulfilled' ? row.value : []));
  // Delta fetch: fold new rows onto the cached feed. Full fetch: replace.
  const next = mergeActivity(
    sinceMs > 0 && cached?.rows?.length ? [cached.rows, ...fetched] : fetched,
    { limit: ACTIVITY_QUERY_LIMIT },
  );
  const prevFp = cached?.fingerprint || activityFingerprint(cached?.rows || []);
  const nextFp = activityFingerprint(next);
  writeActivityCache(uid, address, next);
  if (nextFp !== prevFp) return next;
  if (!cached?.rows?.length && next.length) return next;
  return null;
}

/** The recipient field's query: searchable once 2+ handle characters, not an email or 0x address. */
export function recipientQuery(value) {
  const query = String(value || '').trim();
  const compactQuery = compactRecipientQuery(query);
  const searchable = compactQuery.length >= 2 && !query.includes('@') && !IS_ADDRESS.test(query);
  return { query, compactQuery, searchable };
}

/** Server username search → { status: results | none | signedout, rows }. */
export async function searchRecipients({ query, compactQuery }, token) {
  if (!token) return { status: 'signedout', rows: [] };
  const data = await searchRecipientUsernames(compactQuery || query, token);
  const fromResults = Array.isArray(data.results) ? data.results : [];
  const rows = fromResults.length
    ? fromResults.slice(0, 8)
    : (data.usernames || []).slice(0, 8).map((username) => ({ username, displayName: '' }));
  return { status: rows.length ? 'results' : 'none', rows };
}

export const RECIPIENT_SEARCH_DELAY_MS = 180;

/**
 * Camera + decode loop for a payment QR. A decoded code only PREFILLS the
 * send form — the transfer itself always waits for Send. Returns stop().
 * `getVideo()` is the <video> element (it may mount after this starts).
 */
export function startQrScanner({ getVideo, onScan, onMessage }) {
  let cancelled = false;
  let timer = 0;
  let stream = null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let detector = null;
  if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
    try {
      detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    } catch (_) {
      detector = null;
    }
  }
  onMessage('');
  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
    } catch (_) {
      if (!cancelled) onMessage('Camera unavailable — allow camera access and try again.');
      return;
    }
    if (cancelled) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const video = getVideo();
    if (video) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }
    timer = setInterval(async () => {
      const el = getVideo();
      if (!el || el.readyState < 2) return;
      try {
        let text = '';
        if (detector) {
          const codes = await detector.detect(el);
          text = codes?.[0]?.rawValue || '';
        } else if (el.videoWidth && el.videoHeight) {
          canvas.width = el.videoWidth;
          canvas.height = el.videoHeight;
          ctx.drawImage(el, 0, 0);
          const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
          text = code?.data || '';
        }
        if (!text) return;
        const parsed = parseScannedQr(text);
        if (!parsed) {
          onMessage('Not a Pokoin payment code — keep the code inside the frame.');
          return;
        }
        onScan(parsed);
      } catch (_) {
        // frame skipped — keep scanning
      }
    }, 180);
  })();
  return () => {
    cancelled = true;
    clearInterval(timer);
    stream?.getTracks().forEach((track) => track.stop());
  };
}
