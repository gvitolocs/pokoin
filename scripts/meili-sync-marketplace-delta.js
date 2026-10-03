#!/usr/bin/env node
'use strict';

/**
 * Timer entry kept at the historical Meili filename.
 * Catalog deltas now land in Redis Search. The Meili container is rollback only.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

execFileSync(process.execPath, [path.join(__dirname, 'redis-search-delta.js'), ...process.argv.slice(2)], {
  stdio: 'inherit',
});
