'use strict';

/**
 * One statement: lock the listing row, decrement only for its owner when
 * enough quantity remains, and report why a no-op happened.
 * Inventory never goes negative. Ownership is not a prior SELECT.
 */
const DECREMENT_SQL = `
with locked as (
  select id, seller_uid, quantity_available
  from public.marketplace_user_listings
  where id = $1
  for update
),
updated as (
  update public.marketplace_user_listings as listing
  set
    quantity_available = listing.quantity_available - $3,
    status = case
      when listing.quantity_available - $3 = 0 then 'sold_out'
      else listing.status
    end,
    updated_at = now()
  from locked
  where listing.id = locked.id
    and locked.seller_uid = $2
    and locked.quantity_available >= $3
  returning listing.*
)
select
  case
    when exists (select 1 from updated) then 'updated'
    when not exists (select 1 from locked) then 'missing'
    when exists (select 1 from locked where seller_uid is distinct from $2) then 'forbidden'
    else 'insufficient'
  end as outcome,
  (select row_to_json(updated) from updated) as listing
`;

/**
 * Same predicate as DECREMENT_SQL, for tests and for any caller that already
 * holds the row. `row` is mutated only on success.
 */
function applyDecrement(row, { sellerUid, quantity }) {
  const qty = Number(quantity);
  if (!Number.isSafeInteger(qty) || qty <= 0) {
    return { outcome: 'invalid' };
  }
  if (!row) return { outcome: 'missing' };
  if (row.seller_uid !== sellerUid) return { outcome: 'forbidden' };
  if (Number(row.quantity_available) < qty) return { outcome: 'insufficient' };
  row.quantity_available = Number(row.quantity_available) - qty;
  if (row.quantity_available === 0) row.status = 'sold_out';
  return { outcome: 'updated', listing: { ...row } };
}

function decrementHttpStatus(outcome) {
  if (outcome === 'invalid') return 400;
  if (outcome === 'missing' || outcome === 'forbidden') return 404;
  if (outcome === 'insufficient') return 409;
  return 200;
}

module.exports = {
  DECREMENT_SQL,
  applyDecrement,
  decrementHttpStatus,
};
