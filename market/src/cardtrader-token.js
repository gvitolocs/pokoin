// CardTrader API tokens are RS256 JWTs. A copy from CardTrader's wrapped
// textarea, a "Bearer " prefix, or a password manager filling the field can
// surround a valid token with extra text, and CardTrader then answers 401.
// Mirrors cleanToken / tokenFingerprint in server/pokoin-api/_cardtrader_client.js.

const TOKEN_NOISE_RE = /[\s\u00AD\u200B-\u200D\u2060\uFEFF]/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const RSA_ALG_RE = /^(RS|PS)\d+$/;
const RSA_SIGNATURE_BYTES = new Set([256, 384, 512]);

export const MIN_CARDTRADER_TOKEN_LENGTH = 16;

/** The token CardTrader should see: no whitespace, prefix, quotes, or autofilled text. */
export function normalizeCardTraderToken(raw) {
  const compact = String(raw || '').replace(TOKEN_NOISE_RE, '');
  const jwt = compact.match(JWT_RE);
  if (jwt) return jwt[0];
  return compact
    .replace(/^(?:authorization:)?bearer/i, '')
    .replace(/^["'`]+|["'`]+$/g, '');
}

function decodeSegment(segment) {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

/**
 * What the connect panel can tell about a pasted token without CardTrader:
 * the cleaned token, whether it is a whole JWT, and its non-secret claims.
 * problem: '' | 'not_token' | 'incomplete'.
 */
export function describeCardTraderToken(raw) {
  const input = String(raw || '');
  const token = normalizeCardTraderToken(input);
  const parts = token.split('.');
  const header = parts.length === 3 ? decodeSegment(parts[0]) : null;
  const claims = header ? decodeSegment(parts[1]) : null;
  const jwt = Boolean(header && claims);
  const signatureBytes = jwt ? Math.floor((parts[2].length * 3) / 4) : 0;
  const alg = String(header?.alg || '');
  const complete = jwt && (RSA_ALG_RE.test(alg) ? RSA_SIGNATURE_BYTES.has(signatureBytes) : signatureBytes > 0);
  const iat = Number(claims?.iat);
  let problem = '';
  if (token && !jwt) problem = 'not_token';
  else if (jwt && !complete) problem = 'incomplete';
  return {
    token,
    cleaned: token !== input.trim(),
    jwt,
    complete,
    appName: String(claims?.name || '').trim(),
    issuedAt: Number.isFinite(iat) && iat > 0 ? new Date(iat * 1000) : null,
    problem,
  };
}
