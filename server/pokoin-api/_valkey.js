'use strict';

/**
 * @deprecated Valkey is retired. Use ./_redis_cache (Pi Redis :6380).
 * Thin re-export so undeployed require('./_valkey') paths keep working.
 */
module.exports = require('./_redis_cache');
