# Pokoin Associates

Role-scoped revenue-share partners (distributor, ambassador, …) get a live
earnings desk at **pokoin.com/associate**. Each signed-in associate sees their
own role-flavored page; everyone else sees an invite-only notice.

Ambassadors are **not** a royalty deal: their `/associate` desk is the
Ambassador program (missions → tiers → perks) — see
[REFERRALS.md](REFERRALS.md#ambassador-program). The royalty rules below apply
to distributors (and the generic associate role). Legacy `share_pct` values
on ambassador rows are kept in the table but no longer shown.

## The deal the desk tracks

A sale qualifies when **the seller ships from Italy and the buyer ships to
Italy**. The royalty pool is the Pokoin checkout royalty — 3% of the cards
subtotal (`market/src/checkout-fees.js` `CHECKOUT_COMMISSION_RATE`). Each
associate earns their `share_pct` of that pool on every qualifying order
inside their campaign window.

- Buyer country: the order's `shippingAddressCountryCode` (EUR Stripe orders)
  or the shipments' `toCountry`.
- Seller country: the shipment's `fromCountry`, else the listing row's
  `seller_country` (`marketplace_user_listings`).
- Orders with an unresolvable country are counted as **unverified**, never
  guessed into the pool. PKN escrow orders carry no shipping country until
  address capture, so they land here.
- Fully refunded orders net to zero volume and never accrue.

## Pieces

| Piece | Where |
| --- | --- |
| Roster + deal terms | `public.marketplace_associates` on the nezopt NVMe writer — `scripts/sql/092_marketplace_associates.sql` (email PK, role, share_pct, royalty_pct, window_start/end, active); `city` from `096_ambassador_program.sql`) |
| API | `pokoin-rust/crates/accounts` (`handlers/associate.rs`, `domain/associate.rs`) — `GET /api/marketplace-associate`, Firebase bearer; 403 for non-associates |
| Page | `market/src/pages/Associate.jsx` + `market/src/associate.css`, route `/associate` (`market/src/App.jsx`) |
| Deploy | `scripts/deploy-pokoin-rust.sh` after the commit is on origin/main |

## Seeding an associate

Insert (or upsert) a row on the writer DB:

```sql
insert into public.marketplace_associates
  (email, role, display_name, share_pct, royalty_pct, window_start, window_end, active)
values
  ('someone@gmail.com', 'ambassador', 'Someone', 100, 3,
   '2026-09-29T00:00:00Z', '2026-10-31T23:59:59Z', true)
on conflict (email) do update set role = excluded.role, updated_at = now();
```

`role` is free text; `market/src/pages/Associate.jsx` `ROLES` owns the desk
presentation per role (distributor and ambassador are seeded; unknown roles
fall back to the generic associate desk). The signed-in Firebase account
matches the roster by **email**, so the associate must sign in with the exact
seeded address.

Tests: `cargo test -p pokoin-accounts` in `pokoin-rust/`.
