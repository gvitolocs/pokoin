# Checkout economic contract

Owner-confirmed 17 October 2026. This supersedes earlier copy describing 3% as a seller commission or promising 97% of card prices to sellers.

## One cart, one Stripe payment

Keep the existing platform charge and later separate Connect transfers. Direct Charges and split buyer payments are not selected. A different Connect pricing plan is not implied by these application changes; do not advertise zero Connect costs without the actual account agreement.

- Card item subtotal: the sellers’ prices.
- Pokoin markup: **3% of the total card-item subtotal**, added to the buyer’s bill before Stripe. Round once, half up, in integer minor units. Shipping and optional cover remain separate.
- Buyer total: cards + buyer markup + shipping + optional cover − optional PKN credit discount.
- Seller gross: that seller’s full card subtotal + their shipping. Do not subtract the 3% markup.
- Seller transfer: seller gross − allocated actual processor costs − applicable refunds/adjustments.

For PKN-only orders the buyer pays card subtotal plus 3% and each seller receives their full card subtotal. There is no invented Stripe processing charge on PKN ledger payments.

## Actual payment costs and the single fixed fee

`domain/settlement.rs` uses the fee Stripe actually reports on the original charge’s expanded balance transaction, not an assumed Danish card tariff. This includes the payment’s fixed component exactly once. Actual balance fee details/reference/currency are preserved for audit.

The total charge fee is allocated by each seller’s item-plus-shipping amount. Integer floor shares are computed first; remaining cents go to the largest fractional remainders, with seller ID breaking ties deterministically. Seller shares sum exactly to the actual charge fee; ordering sellers cannot change their allocation. The 3% markup itself is never a seller-cost line.

Example: €100 cards split €75/€25, no shipping/cover/discount. Buyer pays €103. If Stripe reports an actual €1.85 fee, seller cost shares are €1.39/€0.46; transfers are €73.61/€24.54. Transfers €98.15 + Stripe €1.85 + Pokoin markup €3 = buyer €103. The actual fee varies by transaction and agreement.

If Stripe settles the balance transaction in another currency, use that transaction’s exact gross amount relative to the EUR charge amount to translate its fee to EUR cents, rounding once. Store both original amounts and the original currency. Do not treat DKK minor units as EUR cents or hard-code a currency rate.

## Fee availability and payout safety

Stripe fees may arrive asynchronously after payment success. New orders carry `settlementModel: buyer_markup_processor_costs_v1`. Before their first transfer, read the actual fee from Stripe, verify charge/payment-intent/amount/currency, and freeze the allocation in a Firestore transaction. Missing/mismatched costs fail closed for payout; zero is accepted only when Stripe explicitly reports a zero fee. Do not substitute a guessed fee or pretend reconciliation succeeded.

Retries reuse the frozen snapshot and existing per-seller transfer idempotency keys. The freeze reads current shipments transactionally so it cannot overwrite a concurrent refund with stale shipment data. Existing orders without this model retain their original settlement amounts. Delivery confirmation continues to control when seller transfers are attempted.

PKN credit is funded by Pokoin, not taken from seller gross. Credit-funded orders draw from the platform’s prefunded Stripe balance rather than tying transfers to a smaller discounted charge. A platform balance must have real funds available; these changes neither mint fiat nor auto-top-up Stripe. Existing refund policies and PKN-discount refund limitations are not changed by this correction.

## Separately billed Connect costs

Not every Connect cost appears on a charge balance transaction: monthly active-account fees and payout/invoice charges can be billed separately. They must be reconciled from the actual Stripe bill and attributed to the relevant seller/sales period. **Do not charge a monthly account fee per order or the full cart’s fixed fee per seller. Do not deduct a Connect charge twice if Stripe already deducted it from the seller account.**

This change allocates the charge’s actual processor fee. It does not add an automated importer or collection mechanism for separately billed Connect invoices, and does not deduct estimated invoice costs. That separate reconciliation remains necessary when such fees are billed to Pokoin and are to be passed to sellers. Public copy describes verified attributable costs, not a guaranteed zero fee or an invented fixed tariff.

## Code and verification

- Buyer quote/session total: `domain/shipping.rs`, `handlers/addresses.rs`, `handlers/orders.rs`.
- Actual fee retrieval: `ports.rs::payment_charge_with_fees`.
- Allocation/snapshot validation: `domain/settlement.rs`.
- Snapshot freeze and transfer: `handlers/orders.rs::freeze_processor_costs`, `release_seller_transfers`.
- Buyer display: `solid/src/pages/Checkout.jsx`; legacy `commissionPkn` remains a response alias for buyer markup.
- Test coverage: exact cart/quote totals, PKN balance check including markup, allocation conservation/rounding, multi-seller fee sharing, foreign-currency fee conversion, missing/wrong charge data, and unchanged seller gross under PKN discount.

Primary reference: [Stripe actual fee expansion](https://docs.stripe.com/expand/use-cases), [balance transaction fields](https://docs.stripe.com/api/balance_transactions/object), [charge types](https://docs.stripe.com/connect/charges).
