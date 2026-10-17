# EU checkout architecture (Phase 0 audit + design)

**Rule:** start from the cart; Stripe is last. Pipeline:

`CART → group by seller → buyer address → ship-from/to → package tier → rate table → freeze quote → EUR total → Stripe Connect Checkout → verified webhook → PAID → ship → completion → Transfer`

## Audit (2026-09-27)

| Area | Finding |
| --- | --- |
| Cart storage | Browser `localStorage` key `pokoin.cartItems` ([`solid/src/stores/cart.js`](../solid/src/stores/cart.js)). Survives login; not server-synced. Cap 400 rows. |
| Multi-seller | **Allowed.** Each row has `sellerUid`, `listingId`, `qty`, `pricePkn`. No single-seller lock in checkout. |
| Quantity | Per listing; capped by `stock` from the offer. One listing row can hold multiple units of that listing. |
| Checkout API | `POST /api/marketplace-orders` — **site PKN escrow**. Flat `CHECKOUT_SHIPPING_PKN = 2000` remains on the **PKN path only**. |
| Stripe | `/buy` PKN packages via `create-pkn-checkout-session` + `stripe-webhook`. EUR orders use `create-order-checkout-session` + Connect Transfers after delivery confirm. |
| Seller country | Profile `shipFromCountry` (ISO-2). Empty profiles are seeded from request IP (`CF-IPCountry` / Vercel / CloudFront) when that code is an allowed EU sell-from country; otherwise the seller must set it on Profile before listing. Native listing insert rejects `EU`. |
| Saved addresses | `users/{uid}/shipping_addresses/{id}` with `countryCode` plaintext + AES-GCM `encryptedPayload`. |
| Encryption | `ADDRESS_ENCRYPTION_KEY` (32 bytes) on API host; ops mirror on InPhysical — never Firebase. Pattern matches CardTrader token crypto. |
| Shipping tables | `pokoin-rust/crates/commerce/assets/shipping-rates.json` (compiled into the API) + SPA copy. Built by `scripts/sync-shipping-rates.py` from **PackZoo** + **porto-data** + **dao.as/brev** letter grids (smoke-tested each run; cheapest non-express wins; no manual overrides). Quote **fails closed** when no row matches. `EXTRA_LARGE` is the ~20 kg Flex bag/trunk tier; seller packs up to 200 cards use `LARGE`. `/flex` models N sellers sharing one bag; home delivery is one warehouse hop. |

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
| `pokoin-rust-job-eur-orders-sweep.timer` (5 min) | Expires stale sessions and releases (also pre-hold legacy sessions with Stripe's 24 h default), recovers paid sessions whose webhook was missed, resumes partial fulfilment. |

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

## PKN balance as a discount (implemented 2026-09-30)

Buyers keep their PKN even when paying by card: on an EUR checkout, a buyer's
`balances/{uid}.availablePkn` applies as a discount against the card charge —
but only against lines from sellers who accept PKN (PKN-refusing sellers'
lines and their shipping share are card-only, `pokoin-rust/crates/commerce/src/handlers/seller.rs`).

| | |
| --- | --- |
| Discount value | `min(availablePkn, pkn-eligible totalPkn) × €0.005`, capped so the card charge never goes negative |
| Display | Cart + checkout show the split: card charge after the PKN discount, and how much PKN is consumed |
| Settlement | Session create records the discount + freezes the PKN; the verified webhook debits `availablePkn` in the same Firestore transaction that marks the order paid; expiry/cancel releases it exactly once (same lifecycle as the stock hold) |
| Refunds | A refund returns the card share first; the PKN share is credited back to the buyer's balance |
| Status | **Implemented.** `create-order-checkout-session` runs the discount inside the order-write Firestore transaction (balance debit + `pknDiscount: { pkn, eurCents, state: 'held' }`), applies it to the Checkout Session as a one-off coupon, and the paid webhook consumes it. Expiry / cancel / payment-failed release it through `releaseEurReservation` (balance credited, exactly once). The sweep's release path covers webhook misses. Refunds: the card share refunds as today; the PKN discount share is credited back only when the whole order is refunded (partial-refund interplay is a follow-up). The math lives in `_checkout_core.pknBalanceDiscount` (tested). |

## Deploy## Deploy

- SPA: normal `scripts/deploy-web.sh` after merge to `origin/main`.
- API: the Rust release (`scripts/deploy-pokoin-rust.sh`; addresses, quote, Connect, order session, webhook and orders live in `pokoin-rust/crates/commerce`).
- Sweep: the native job `pokoin-rust-job@eur-orders-sweep` every five minutes ([RUST_RUNTIME.md](RUST_RUNTIME.md)).
- Ensure `ADDRESS_ENCRYPTION_KEY` is set in the Pi Rust env (`/srv/pokoin/rust/pokoin-api.env`) before first address write.

Refresh rates with `scripts/sync-shipping-rates.py` (PackZoo + porto-data + dao letters; writes API + SPA JSON). Daily timer: `pokoin-shipping-rates-sync.timer`. The API copy is compiled in, so new rates need a Rust release plus the web deploy.

## Shipping service per seller parcel (2026-10-14)

Each seller's cards ship as one parcel on that seller's lane, and the buyer picks a
service for each parcel (cart `/cart`, then `/checkout`). The cart keeps the picks
as `cartShippingChoice().parcels` (`{ sellerUid: serviceId }`, session storage);
checkout prefills from them (`checkoutParcelShipping` in
[`market/src/checkout-model.js`](../market/src/checkout-model.js)) and sends them
to both `POST /api/marketplace-checkout-quote` and
`POST /api/create-order-checkout-session`:

```json
{ "shippingServices": { "sellerUidA": "untracked", "sellerUidB": "tracked" },
  "shippingService": "untracked", "tracked": false, "insurance": false }
```

- `shippingServices` (object, or `[{ sellerUid, serviceId }]`) wins per seller;
  sellers it leaves out use the order-wide `tracked` / `shippingTracked` /
  `shippingService` flag, which is how older clients still work.
- Bookable services are the letter rates, `tracked` and `untracked`. Live Packlink
  rates (`packlink:N`) are quotes only: nothing buys their labels and
  `PACKLINK_API_KEY` is unset in production, so the cart does not offer them and
  the API refuses a Packlink parcel (400 `shipping_service_unavailable`) instead of
  re-pricing it. Unknown ids are 400 `invalid_shipping_service`.
- The €20 untracked cap applies to the order: any untracked parcel on a card
  subtotal above €20 is 400 `untracked_not_allowed`. Insurance (5%) is unchanged.
- The session prices exactly like the quote (same services, cap and insurance),
  stores `serviceId`, `rateId`, `carrier` and `serviceName` on each `shipments[]`
  row plus `insuranceEURCents`, and answers `checkoutUrl` (and `url`).
- Quote shipments carry `serviceId`; the quote also returns `shippingServices`.

## PKN balance discount on a card checkout (2026-10-16)

The buyer only opts in: quote and session both take `usePknDiscount: true` (a
legacy numeric `pknDiscount` > 0 is read as the same opt-in; its amount is
ignored). The server prices the discount itself with one rule
(`money::checkout_pkn_discount`): the buyer's Firestore `balances/{uid}`
available PKN, only lines from sellers whose profile does not say
`acceptsPkn: false`, 2 PKN per euro-cent, and a card charge never below 50 cents.

- The quote answers `pknVoucher` (what the buyer could take), `pknDiscount`
  (`applied` only when opted in), `pknRefusedSellers` and `chargeCents`
  (= `grandTotalCents` − `pknDiscount.eurCents`). Checkout shows those numbers.
- The session locks the same amount (`order_discount_held`), charges
  `chargeCents`, stores `pknDiscount` on the order and answers `chargeCents` and
  `pknDiscount`. The webhook's expected charge is `totalEURCents − pknDiscount.eurCents`.

### Local checkout end to end (Stripe test mode)

`pokoin-rust/crates/commerce/examples/checkout_e2e.rs` runs the real commerce
router on `127.0.0.1:8790` against the Firestore emulator (project
`demo-pokoin-e2e`), a throwaway Postgres and Stripe TEST mode. It refuses a live
Stripe key and anything not on localhost, and seeds one buyer (1000 PKN), two
sellers (Italy, Denmark) and a two-parcel cart on every start.

```sh
docker run -d --name pokoin-checkout-e2e-pg -e POSTGRES_USER=e2e -e POSTGRES_PASSWORD=e2e \
  -e POSTGRES_DB=e2e -p 127.0.0.1:55432:5432 postgres:17-alpine
java -jar ~/.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar --host 127.0.0.1 --port 8086 &
set -a; . ~/.config/pokoin/stripe-test.env; set +a   # STRIPE_SECRET_KEY=sk_test_...
POKOIN_LISTING_SYNC_WORKER=0 POKOIN_SYNC_CONSUMER=0 \
  cargo run -p pokoin-commerce --example checkout_e2e
cd solid && VITE_POKOIN_API_ORIGIN=http://127.0.0.1:5199 POKOIN_API_PROXY=http://127.0.0.1:8790 \
  npx vite --host 127.0.0.1 --port 5199 --strictPort
```

In the browser on `http://127.0.0.1:5199`, sign in as the seeded buyer with the
cookie `pokoin.auth.token={"token":"e2e-buyer-token-not-a-firebase-jwt","uid":"e2e-buyer","expiresAt":<ms>}`
and `localStorage['pokoin.auth.session']={"uid":"e2e-buyer","signedIn":true}`, then
use `/cart` → `/checkout` and pay with Stripe's test card `4242 4242 4242 4242`.
`VITE_POKOIN_API_ORIGIN` only works under `vite dev`; production builds ignore it.

## Buyer markup and processor-cost correction (17 October 2026)

The owner clarified that Pokoin’s 3% is a **buyer markup**, not a deduction from
seller prices. The quote/session now add it to card items before Stripe. Seller
gross is full card value + shipping, less actual allocated processor costs.
The one cart payment and delayed per-seller Connect Transfers remain. See
[CHECKOUT_FEES.md](CHECKOUT_FEES.md) for exact rounding, asynchronous fee
reconciliation, compatibility, PKN credit funding and separately billed Connect
cost scope. Earlier references to 97% seller settlement are historical.
