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
| Shipping tables | `server/pokoin-api/shipping-rates.json` (+ SPA copy). Built by `scripts/sync-shipping-rates.py` from **PackZoo** + **porto-data** + **dao.as/brev** letter grids (smoke-tested each run; cheapest non-express wins; no manual overrides). Quote **fails closed** when no row matches. `EXTRA_LARGE` is the ~20 kg Flex bag/trunk tier; seller packs up to 200 cards use `LARGE`. `/flex` models N sellers sharing one bag; home delivery is one warehouse hop. |

| Orders | Firestore `orders` with `shipments[]`, `totalEURCents`, encrypted immutable address snapshot. |
| Connect | Sellers can finish Stripe Connect later. Buyer EUR pay only needs seller `shipFromCountry`. Connect Transfers run after delivery when the seller is `READY` (account resolved at payout time). |

## Design decisions locked

- Origin: ISO 3166-1 alpha-2 only (`EU` rejected).
- `countryCode` stored plaintext for rate lookup; street/name/city/postal only in ciphertext.
- Address key: `ADDRESS_ENCRYPTION_KEY` on API host; ops mirror on InPhysical — never Firebase.
- Package tiers from seed table `maxCards` bands (see rates file).
- Multi-seller: one Checkout Session charges the platform for the cart total, with **one Stripe line item per seller shipment**. After delivery confirm, `releaseSellerTransfers` creates **one Connect Transfer per seller** (Separate Charges and Transfers + `transfer_group` + `source_transaction`). Not a single payout to one seller.
- **PKN path:** keeps flat `CHECKOUT_SHIPPING_PKN = 2000` until the same rate table is converted at the fixed PKN↔EUR ratio. EUR physical checkout never uses the flat fee.
- Seller address reveal: `POST /api/marketplace-orders?action=reveal-shipping` decrypts the snapshot only for a seller on that order (plus their shipment subset).

## Inventory lifecycle (2026-09-28)

Before this, a Stripe EUR order never touched stock: `create-order-checkout-session`
wrote `pending_stripe`, the webhook only flipped `paymentStatus`, and even a paid
card stayed on Shop. A cancelled Stripe tab also left a forever-open `eur_*` order.

| Step | What happens |
| --- | --- |
| Session create | Prices re-read from `marketplace_user_listings` (client prices never reach Stripe). Stock is taken with the PKN-path decrement (`qty--`, `sold_out` at 0). Order gets `inventory { state: reserved, lines, expiresAt }`. Stripe `expires_at` = now + 31 min. Any failure after the decrement puts the stock back. |
| `checkout.session.completed` (paid) | `paymentStatus: paid`, then `fulfillPaidEurOrder` once: commit hold → seller ownership decrement → linked CardTrader decrement → CardTrader buy-through → seller emails → `marketplace_sales` rows. Each step records itself on `order.fulfillment`, so a retry resumes. |
| Paid after the hold was released | Stock is taken again; if it's gone, `fulfillmentStatus: needs_refund` (ops refunds). |
| `completed` with `payment_status: unpaid` | `processing`; hold kept until `async_payment_succeeded` / `async_payment_failed`. |
| `checkout.session.expired`, buyer Cancel, `async_payment_failed` | Hold released exactly once; order `expired` / `cancelled` / `failed`; Orders says "not charged". |
| `pokoin-eur-orders-sweep.timer` (5 min) | Expires stale sessions and releases (also pre-hold legacy sessions with Stripe's 24 h default), recovers paid sessions whose webhook was missed, resumes partial fulfilment. |

Stripe must send `checkout.session.expired`, `checkout.session.async_payment_succeeded`
and `checkout.session.async_payment_failed` to `/api/stripe-webhook` (the sweep
covers them if it doesn't).

## Sold history and partial refunds

- `GET /api/marketplace-orders?action=sold-history` (seller): paid native orders
  (their lines only) plus linked CardTrader sales. UI: `/sales`.
- `POST /api/marketplace-orders?action=refund` `{ orderId, amount, reason, clientToken }`:
  seller refunds any whole amount up to what is left of their share (EUR: their
  parcel items + shipping, cents; PKN: their item total). The cap is reserved in a
  Firestore transaction; `clientToken` makes double clicks one refund.
  - EUR before payout: Stripe refund; that seller's Transfer shrinks (`shipments[].refundedCents`).
  - EUR after payout: Stripe refund + Transfer reversal of the same amount.
  - PKN escrow: buyer balance credited; escrow release pays the seller less.
  - PKN released: seller balance debited (must cover it), buyer credited.
  - Whole share refunded → that seller's `marketplace_sales` rows are voided.
- `GET /api/marketplace-native-sales?cardId=` (public): "Sold on Pokoin" on the
  card desk — date, condition, language, qty, price; never the buyer.

## Seed package tiers

| Tier | maxCards (inclusive) |
| --- | --- |
| SMALL | 4 |
| MEDIUM | 20 |
| LARGE | 200 |
| EXTRA_LARGE | 9999 (Flex bag / trunk only when looked up by tier id) |

## Deploy

- SPA: normal `scripts/deploy-web.sh` after merge to `origin/main`.
- API: `scripts/deploy-checkout-eur-api.sh` (addresses, quote, Connect, order session, webhook/orders overlay + route manifest patch).
- Sweep timer: `scripts/deploy-eur-orders-sweep-timer.sh` after the API deploy (runs a `--dry-run` first).
- Ensure `ADDRESS_ENCRYPTION_KEY` is set on `pokoin-oracle-api` before first address write.

Refresh rates with `scripts/sync-shipping-rates.py` (PackZoo + porto-data + dao letters; writes API + SPA JSON). Daily timer: `pokoin-shipping-rates-sync.timer`. Then redeploy checkout API + web.
