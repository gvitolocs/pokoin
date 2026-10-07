'use strict';

/**
 * Partner providers (CCGSeller, Storepass, Sortswift, Magus Shop).
 *
 * Their APIs are not configured yet: Pokoin stores the request with
 * `state: 'pending_activation'` and staff activate it later. There is no
 * order poll and no stock write in the meantime — see docs/PLATFORM_SYNC.md.
 */

function platformError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function cleanText(value, maxLength = 400) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

/** Accept the partner request; nothing is called out to the partner yet. */
async function validate(ctx, input = {}) {
  // Measure before truncating: a 513-character key must be rejected, not cut
  // down to a valid length.
  const rawKey = String(input.apiKey == null ? '' : input.apiKey).trim();
  if (rawKey.length < 8 || rawKey.length > 512) {
    throw platformError(
      'partner_api_key_invalid',
      'Enter a valid partner API key (8 to 512 characters).',
      400,
    );
  }
  const apiKey = rawKey.slice(0, 512);
  return {
    credentials: { apiKey },
    metadata: { storeId: cleanText(input.storeId, 120) },
    state: 'pending_activation',
  };
}

/** No partner stock write until the partner API is configured. */
async function adjustStock() {
  return { ok: false, skipped: true, reason: 'partner_pending' };
}

module.exports = {
  validate,
  adjustStock,
};
