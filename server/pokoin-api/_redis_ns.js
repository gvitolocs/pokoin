'use strict';

/**
 * Versioned Redis key namespaces for the shared Pi Redis (:6380).
 *
 * Search documents stay on `pokoin:card:{id}` / index `pokoin:cards`
 * (Redis Search). Everything else under this helper is disposable cache.
 *
 * Bump the version segment (v1 → v2) to invalidate a whole family after a
 * payload schema change without SCAN/DEL.
 */

const MARKETPLACE = 'pokoin:marketplace:v1';
const SELLER = 'pokoin:seller:v1';
const RL = 'pokoin:rl:v1';
const LOCK = 'pokoin:lock:v1';
const REFERENCE = 'pokoin:reference:v1';

function join(prefix, parts) {
  const body = parts
    .map((part) => String(part == null ? '' : part).trim())
    .filter(Boolean)
    .join(':');
  return body ? `${prefix}:${body}` : prefix;
}

function marketplaceKey(...parts) {
  return join(MARKETPLACE, parts);
}

function sellerKey(...parts) {
  return join(SELLER, parts);
}

function rateLimitKey(...parts) {
  return join(RL, parts);
}

function lockKey(...parts) {
  return join(LOCK, parts);
}

function referenceKey(...parts) {
  return join(REFERENCE, parts);
}

/** Generation counter used to atomically invalidate a cache family. */
function generationKey(scope) {
  return marketplaceKey('gen', scope);
}

module.exports = {
  MARKETPLACE,
  SELLER,
  RL,
  LOCK,
  REFERENCE,
  marketplaceKey,
  sellerKey,
  rateLimitKey,
  lockKey,
  referenceKey,
  generationKey,
};
