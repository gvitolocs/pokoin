# Selling offers: evidence and scope

> Superseded economic interpretation: the owner clarified on 17 October 2026
> that 3% is a BUYER markup, not a seller commission. Keep one multi-seller
> Stripe charge. Seller receives full items + shipping less actual attributed
> payment costs. See [current fee contract](../../CHECKOUT_FEES.md).


Reviewed 17 October 2026. This records the basis for homepage copy; it does not change checkout rates or implement an intake/payment system.

## Three different offers

| Offer | What the customer receives | Basis |
| --- | --- | --- |
| Self-service marketplace | Real-money card-payment settlement, or seller-supported PKN | Existing 3% marketplace commission |
| Send cards for immediate credit | PKN at 90% of market value, minimum 1 PKN per card; no resale wait | Owner’s explicit instructions in this chat |
| Send cards for managed selling | Real-money proceeds after sale | Owner requested one percentage point below CardTrader 1-Day Ready; 15.5% base commission |

The last two are distinct services. Their public CTAs lead to Contact to coordinate sending cards, valuation and issuance/payment. No automated receipt, guaranteed processing time or automatic token award is claimed. The homepage’s “instant” label describes no wait for resale; the detail page tells users to coordinate card receipt and credit issuance.

The owner confirmed the 90% and minimum 1 PKN terms in this chat and clarified that managed sale proceeds are real money, while immediate credit is PKN. A deep Honcho query, conclusion searches and Codevira searches did not establish a prior implemented intake flow. The memory response also recalled outdated infrastructure, which was not used as current implementation evidence. The existing CardTrader 1-DR page is an external-account stock/sales viewer, not a Pokoin trade-in intake.

## Stripe check

Code inspected:

- `market/src/checkout-fees.js`: 3% commission and optional 5% cover; no extra Stripe fee calculation.
- `solid/src/pages/Checkout.jsx`: Stripe/card and PKN payment paths; seller PKN acceptance checks.
- `pokoin-rust/crates/commerce/src/handlers/orders.rs`: `eur_order_shipments` computes seller transfer as rounded 97% of item subtotal plus seller shipping; refunds/adjustments can reduce it. `create_order_checkout_session` charges the platform; `release_seller_transfers` creates later separate Connect transfers.
- `pokoin-rust/crates/commerce/src/domain/shipping.rs`: card quote is items plus shipping; optional insurance is separate.
- `pokoin-rust/crates/commerce/src/ports.rs`: Checkout Session and transfer API calls use the platform account.
- `pokoin-rust/crates/commerce/src/handlers/stripe.rs`: Express connected accounts and payment completion handling.
- `pokoin-rust/crates/commerce/src/handlers/wallet.rs`: reviewed PKN withdrawal handler, not used to infer Stripe bank-payout fees.

Conclusion from current code: it does **not** deduct a second Stripe processing fee from the calculated seller transfer. Stripe charges the platform in the separate-charges-and-transfers model. Thus Stripe cost reduces Pokoin’s margin; “Stripe is free” would be false. The repository does not establish the Stripe account’s contracted processing rate, external bank-payout charges, currency conversion or optional service pricing. No specific live Stripe rate was invented, and no live payments were made.

Primary references: [Stripe’s charge model](https://docs.stripe.com/connect/separate-charges-and-transfers), [Stripe’s own integration decision matrix](https://github.com/stripe/ai/blob/main/providers/agent-plugins/plugin/skills/connect-recommend/references/decision-matrix.md), [Stripe Connect pricing](https://stripe.com/connect/pricing).

## Managed-selling comparison

[CardTrader’s official fee table](https://static.cardtrader.com/en/pages/payments-fees-and-refunds), checked 17 October 2026, publishes 16.5% for 1-Day Ready (minimum 1 cent), with VAT added under its policy. The owner’s “1% less” instruction is implemented in the copy as **one percentage point less: 15.5%**, not a 1% relative reduction. This is a comparison of base commission rates, not an all-in cost guarantee.

The 15.5% managed-selling offer is owner-directed service copy, **not** the 3% rate in marketplace checkout. It does not claim that the existing Stripe checkout implements consignment settlement. Intake/payout terms and any separate taxes/costs need to be agreed directly. No guarantee of a higher net return than 90% immediate credit is made: final sale price and timing vary.
