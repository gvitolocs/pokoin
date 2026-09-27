# EU checkout architecture (Phase 0 audit + design)

**Rule:** start from the cart; Stripe is last. Pipeline:

`CART → group by seller → buyer address → ship-from/to → package tier → rate table → freeze quote → EUR total → Stripe Connect Checkout → verified webhook → PAID → ship → completion → Transfer`

## Audit (2026-09-27)

| Area | Finding |
| --- | --- |
| Cart storage | Browser `localStorage` key `pokoin.cartItems` ([`market/src/cart.jsx`](../market/src/cart.jsx)). Survives login; not server-synced. Cap 400 rows. |
| Multi-seller | **Allowed.** Each row has `sellerUid`, `listingId`, `qty`, `pricePkn`. No single-seller lock in checkout. |
| Quantity | Per listing; capped by `stock` from the offer. One listing row can hold multiple units of that listing. |
| Checkout API | `POST /api/marketplace-orders` — **site PKN escrow**. Flat `CHECKOUT_SHIPPING_PKN = 2000` remains on the **PKN path only**. |
| Stripe | `/buy` PKN packages via `create-pkn-checkout-session` + `stripe-webhook`. EUR orders use `create-order-checkout-session` + Connect Transfers after delivery confirm. |
| Seller country | Profile `shipFromCountry` (ISO-2). Empty profiles are seeded from request IP (`CF-IPCountry` / Vercel / CloudFront) when that code is an allowed EU sell-from country; otherwise the seller must set it on Profile before listing. Native listing insert rejects `EU`. |
| Saved addresses | `users/{uid}/shipping_addresses/{id}` with `countryCode` plaintext + AES-GCM `encryptedPayload`. |
| Encryption | `ADDRESS_ENCRYPTION_KEY` (32 bytes) on API host; ops mirror on InPhysical — never Firebase. Pattern matches CardTrader token crypto. |
| Shipping tables | Seeded in-repo `server/pokoin-api/shipping-rates.json` (+ SQL stub `scripts/sql/080_shipping_rates.sql`). Quote **fails closed** when no row matches. |
| Orders | Firestore `orders` with `shipments[]`, `totalEURCents`, encrypted immutable address snapshot. |
| Connect | Sellers need `stripeConnectAccountId` + `stripeConnectStatus=READY` before EUR pay. |

## Design decisions locked

- Origin: ISO 3166-1 alpha-2 only (`EU` rejected).
- `countryCode` stored plaintext for rate lookup; street/name/city/postal only in ciphertext.
- Address key: `ADDRESS_ENCRYPTION_KEY` on API host; ops mirror on InPhysical — never Firebase.
- Package tiers from seed table `maxCards` bands (see rates file).
- Multi-seller: one Checkout Session charges the platform for the cart total, with **one Stripe line item per seller shipment**. After delivery confirm, `releaseSellerTransfers` creates **one Connect Transfer per seller** (Separate Charges and Transfers + `transfer_group` + `source_transaction`). Not a single payout to one seller.
- **PKN path:** keeps flat `CHECKOUT_SHIPPING_PKN = 2000` until the same rate table is converted at the fixed PKN↔EUR ratio. EUR physical checkout never uses the flat fee.
- Seller address reveal: `POST /api/marketplace-orders?action=reveal-shipping` decrypts the snapshot only for a seller on that order (plus their shipment subset).

## Seed package tiers

| Tier | maxCards (inclusive) |
| --- | --- |
| SMALL | 4 |
| MEDIUM | 20 |
| LARGE | 50 |
| EXTRA_LARGE | 9999 |

## Deploy

- SPA: normal `scripts/deploy-web.sh` after merge to `origin/main`.
- API: `scripts/deploy-checkout-eur-api.sh` (addresses, quote, Connect, order session, webhook/orders overlay + route manifest patch).
- Ensure `ADDRESS_ENCRYPTION_KEY` is set on `pokoin-oracle-api` before first address write.

Replace `server/pokoin-api/shipping-rates.json` (and CardVault copy) when the real matrix arrives.
