'use strict';

/**
 * Dry-run report: which live physical listings could backfill Firestore ownership.
 * Does NOT write. Does NOT touch production Firestore.
 *
 * Usage (nezopt / writer tunnel):
 *   node scripts/report-listing-collection-backfill.js
 *   node scripts/report-listing-collection-backfill.js --json
 *
 * Env: MARKETPLACE_WRITER_DATABASE_URL or DATABASE_URL
 */

const { Client } = require('pg');

async function main() {
  const asJson = process.argv.includes('--json');
  const url = process.env.MARKETPLACE_WRITER_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('Set MARKETPLACE_WRITER_DATABASE_URL or DATABASE_URL');
    process.exit(1);
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(`
      select
        coalesce(nullif(source, ''), 'unknown') as source,
        coalesce(nullif(status, ''), 'unknown') as status,
        seller_uid,
        count(*)::int as listings,
        coalesce(sum(quantity_available), 0)::int as quantity
      from public.marketplace_user_listings
      where coalesce(quantity_available, 0) > 0
        and status in ('active', 'paused')
      group by 1, 2, 3
      order by source, status, listings desc
    `);

    const scanEligible = rows.filter((r) => r.source === 'pokoin_scan_batch');
    const summary = {
      note: 'Dry-run only. Proposed first backfill: source=pokoin_scan_batch, status active|paused, qty>0. Do not treat sold_out as owned. Firestore match check requires a separate Admin SDK pass.',
      groups: rows,
      scanBatchEligible: {
        listings: scanEligible.reduce((n, r) => n + r.listings, 0),
        quantity: scanEligible.reduce((n, r) => n + r.quantity, 0),
        sellers: new Set(scanEligible.map((r) => r.seller_uid)).size,
      },
      allLiveEligible: {
        listings: rows.reduce((n, r) => n + r.listings, 0),
        quantity: rows.reduce((n, r) => n + r.quantity, 0),
        sellers: new Set(rows.map((r) => r.seller_uid)).size,
      },
    };

    if (asJson) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(summary.note);
      console.log('\nBy source / status / seller:');
      for (const row of rows) {
        console.log(
          `  ${row.source}\t${row.status}\t${row.seller_uid}\tlistings=${row.listings}\tqty=${row.quantity}`,
        );
      }
      console.log('\nScan-batch eligible:', summary.scanBatchEligible);
      console.log('All live eligible:', summary.allLiveEligible);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
