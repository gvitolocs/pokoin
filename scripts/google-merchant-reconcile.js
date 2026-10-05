'use strict';

const { readFileSync } = require('fs');
const { reconcileProducts } = require('../server/pokoin-api/google-merchant/reconcile');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function loadJson(path) {
  if (!path) return [];
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main() {
  const dryRun = !process.argv.includes('--apply');
  const local = loadJson(arg('--local'));
  const remote = loadJson(arg('--remote'));
  const diff = reconcileProducts(local, remote);
  const report = {
    dryRun,
    missing: diff.missing,
    stale: diff.stale,
    priceMismatch: diff.priceMismatch,
    currencyMismatch: diff.currencyMismatch,
    sellerMismatch: diff.sellerMismatch,
    extra: diff.extra,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!dryRun) {
    console.error('Refusing to mutate Google from this script without a configured Merchant client run.');
    console.error('Pass the diff to the sync service after GOOGLE_MERCHANT_DRY_RUN=0 is set on the API.');
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
