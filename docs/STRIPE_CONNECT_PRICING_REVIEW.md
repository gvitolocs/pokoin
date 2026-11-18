# Stripe Connect pricing and Direct Charges review

> Superseded economic interpretation: the owner clarified on 17 October 2026
> that 3% is a BUYER markup, not a seller commission. Keep one multi-seller
> Stripe charge. Seller receives full items + shipping less actual attributed
> payment costs. See [current fee contract](CHECKOUT_FEES.md).


Checked 17 October 2026. Scope: repository implementation and Stripe’s public documentation. This is not confirmation of the live Stripe Dashboard’s pricing agreement. No live Stripe accounts, charges, payouts or application settings were changed during this review.

## Verdict

The proposed combination—Stripe handles pricing and Direct Charges—is a valid way to make the connected seller pay Stripe processing and avoid additional Connect account/standard payout fees for the platform under the published plan. It is **not the current Pokoin integration**, and cannot be enabled by changing a marketing fee table or just the connected-account type.

Stripe’s Danish standard processing price is **1.5% + DKK 1.80** for standard EEA cards. Premium EEA, UK/international cards, conversion and optional services have different prices. Danish pricing cannot be applied to every connected seller country. Fees apply to the processed amount, which can include shipping, rather than only the card-item subtotal.

The earlier 3% Pokoin commission is separate from Stripe’s processing fee. If retained with Direct Charges, the seller pays both. Example: DKK 100 item charge, no shipping/conversion/other adjustments, standard EEA card under Danish pricing: DKK 3 Pokoin + DKK 3.30 Stripe; seller net DKK 93.70. This is an illustration, not a live Stripe quote.

## Current code vs proposed configuration

| Area | Current code | Direct Charges target |
| --- | --- | --- |
| Charge owner | Platform; one EUR Checkout Session for the complete cart | Connected seller; one charge per seller |
| Multiple sellers | One payment split into later Connect Transfers | Separate seller payments/sessions; multiple authorizations and partial completion must be handled |
| Fee payer | Stripe processing comes from the platform balance | Seller processing fee under its Stripe pricing |
| Pokoin revenue | Transfer 97% of items plus shipping, keeping 3% before platform costs | Explicit application fee if 3% is retained |
| Onboarding | Creates `type=express` accounts | Compatible seller-paid-pricing account configuration/onboarding; existing accounts must be checked, not silently replaced |
| Delivery protection | Platform retains funds until delivery and releases Transfers | Charge resides in seller’s balance; existing Transfer-based hold/release does not apply |
| Refunds | Platform-scoped charge/refund and Transfer reversal paths | Seller-scoped refund, explicit application-fee refund policy |
| Webhooks | Platform session/event flow | Connect events with validated `event.account`, connected-account session validation and separate webhook configuration |
| PKN credit | Platform discounts reduce the single card charge | Needs an explicit cross-account funding/reimbursement design; reducing a direct charge otherwise reduces seller receipts |
| Standard payouts | Existing account agreement not verified | Published Stripe-handled plan adds no Connect standard payout fee; Instant/cross-border/FX and other services are separate |

A Direct Charge must not be represented as the current platform escrow/Transfer protection. Seller availability, account capabilities and payout control need verification before enabling the new path. Do not make new Direct Charges until their complete success, cancel, expiry, refund and dispute lifecycles are supported. Existing paid/pending orders must continue using their original account and charge type.

## Evidence in the repository

- `pokoin-rust/crates/commerce/src/handlers/stripe.rs`: `stripe_connect_onboard_post` creates Express accounts; `handle_event` / `fulfil_eur_order` process platform Checkout events.
- `pokoin-rust/crates/commerce/src/handlers/orders.rs`: `create_order_checkout_session` builds a platform Checkout Session; `eur_order_shipments` calculates 97% item proceeds plus shipping; `release_seller_transfers` pays connected accounts after delivery. Cancellation, expiry and refunds currently retrieve platform-scoped Stripe objects.
- `pokoin-rust/crates/commerce/src/ports.rs`: Stripe Session/refund requests use the platform key without a `Stripe-Account` header.
- `pokoin-rust/crates/commerce/src/domain/shipping.rs`: multiple seller parcels are priced into a cart quote; insurance separate.
- `solid/src/pages/Checkout.jsx`: one Stripe session navigation for the cart, Stripe/PKN paths and optional PKN balance credit.
- `docs/CHECKOUT_EUR.md`: current one-payment/multiple-seller and hold-until-delivery contract.

## Concrete migration requirements

1. Decide whether buyers accept separate seller payments, and whether the 3% Pokoin fee stays in addition to Stripe.
2. Verify connected-account configuration and live Dashboard pricing. Preserve existing Express accounts and historical orders; use a deliberate onboarding/migration process for new seller-paid accounts.
3. Add seller-scoped Stripe request context for creation, retrieval, expiry, refund and reconciliation. Store that context immutably on each order/payment.
4. Split cart payment state into seller orders or a parent checkout with individually payable children. Reserve/release stock and apply PKN credit without double consumption or loss on partial cancellation.
5. Collect the selected Pokoin application fee explicitly, and define refund treatment. Reconcile actual processor fees instead of calculating an assumed universal Danish rate.
6. Validate Connect webhook account ownership against the persisted seller/order before marking paid. Keep platform webhook handling for PKN top-ups and legacy orders.
7. Rework delivery protection and seller payout control explicitly. Reuse neither `release_seller_transfers` nor the old “97% plus shipping” promise for direct payments.
8. Test account isolation, fees, duplicate/out-of-order events, partial multi-seller completion, expiry, stock restoration, PKN credit and refunds in Stripe test mode before release.
9. Update public fee/protection pages only with the actually implemented payment model. Push/deploy remains a separate explicit instruction.

## Primary sources

- [Stripe Denmark Payments pricing](https://stripe.com/en-dk/pricing)
- [Stripe Denmark Connect pricing](https://stripe.com/en-dk/connect/pricing)
- [Stripe charge-type comparison](https://docs.stripe.com/connect/charges)
- [Direct Charges with Stripe Checkout](https://docs.stripe.com/connect/direct-charges?platform=web&ui=stripe-hosted)
- [Stripe account controller properties](https://docs.stripe.com/connect/migrate-to-controller-properties)

Pending product decisions are requested in this chat. This review does not claim the proposed configuration has been activated.
