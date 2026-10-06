# Google Customer Reviews opt-in

Pokoin asks buyers for a Google Customer Reviews rating on the order
confirmation. The integration is the Google "survey opt-in" module from
`platform.js`, merchant id **5869935257** (`GCR_MERCHANT_ID` in
`market/src/google-reviews.js`).

## Where it renders

- `market/src/pages/Orders.jsx` — the Stripe return lands on
  `/orders?eur_session=…&order=<id>`. When that returned order shows up in the
  buyer's `bought` list and is physical (`fulfillmentMode !== 'nft_only'`), the
  effect calls `showReviewsOptIn`. Other rows never trigger the dialog.
- `market/src/pages/Checkout.jsx` — the PKN path (`placePkn`) calls it right
  after `setOrderId(id)` when the order is physical (`!nft`), so the dialog
  can appear even without a Stripe round trip.

Both paths go through the same helpers in `market/src/google-reviews.js`, and
the order is remembered in `sessionStorage` under `pokoin.gcr.<orderId>`, so a
refresh or a second effect run never opens the dialog twice.

## Fields and their sources

`optInFields()` builds the payload Google's `gapi.surveyoptin.render` expects
and returns `null` when any required field is missing, so a half-known order is
simply skipped:

| Field | Source |
| --- | --- |
| `merchant_id` | `GCR_MERCHANT_ID` = 5869935257 (number) |
| `order_id` | order id from `/orders` or `createMarketplaceOrder` |
| `email` | `order.buyerEmail` (Orders) or `user.email` (both) |
| `delivery_country` | `order.shippingAddressCountryCode` / `buyerCountry`, uppercased ISO 3166-1 alpha-2 |
| `estimated_delivery_date` | `estimatedDeliveryDate()` below |

Validation: `order_id` non-empty, `email` contains `@`, `delivery_country` is
exactly two letters (uppercased), `estimated_delivery_date` matches
`YYYY-MM-DD`. `products` / GTIN are omitted — trading cards have no GTIN.

## Delivery estimate (+7 / +14)

`estimatedDeliveryDate({ orderedAt, shipments, toCountry })` returns a UTC
`YYYY-MM-DD`:

- **+7 days** when there is at least one shipment and every shipment's
  `fromCountry` equals `toCountry` (case-insensitive) — a domestic parcel.
- **+14 days** for a mixed/foreign parcel, or when no shipment data exists yet.

`orderedAt` accepts a `Date`, epoch milliseconds, or a Firestore timestamp
(`toMillis()` or `seconds`); an invalid value falls back to now. Checkout passes
`Date.now()` and builds shipments from `sellerParcels` (each group has `.from`).

## CSP

The site CSP allows `script-src 'self' https://apis.google.com https://www.gstatic.com …`
and has **no `'unsafe-inline'`**, so Google's inline snippet would be blocked.
`market/src/google-reviews.js` therefore injects
`<script async defer src="https://apis.google.com/js/platform.js?onload=__pokoinRenderGcrOptIn">`
from JS exactly once, defines the global `__pokoinRenderGcrOptIn` callback, and
calls `gapi.load('surveyoptin', …)`. If the script is already on the page and
`gapi` is loaded, the callback runs directly instead of adding a second tag.
Nothing here changes the CSP or `market/src/content-security.test.js`.

## How to test

1. Run the unit tests: `node --test market/src/google-reviews.test.js` (and the
   whole `market/src/*.test.js` suite).
2. Complete a test checkout of a physical card (Stripe or PKN) with an email
   that a Google test account can see, and land on `/orders`.
3. The Google dialog appears once for that order; a refresh does not show it
   again. Confirm the payload in devtools by logging
   `gapi.surveyoptin.render` or checking the network call to Google.
