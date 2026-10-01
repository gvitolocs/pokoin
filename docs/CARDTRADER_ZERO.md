# CardTrader Zero list

Pokoin page: `/mypokoin/zero` (MyPokoin → **CardTrader Zero**).
API: `GET /api/cardtrader-zero`, `GET/POST/DELETE /api/powertools-connect`.

## What the Thursday list is

CardTrader API v2 Orders, Zero lifecycle:

| Seller order state | `via_cardtrader_zero` | Meaning |
|---|---|---|
| `hub_pending` | `true` | One Zero sale during the week |
| `closed` | `true` | A `hub_pending` order merged into the weekly batch |
| `paid` | `true` | **The weekly merged order**: every item of the week, to ship to the hub |
| `sent` → … | `true` | The weekly order after shipping |

The list Power Tools loads on Thursday is that weekly merged `paid` order.
Power Tools does not compute it. Its `GET /api/user/order` mirrors CardTrader orders keyed by
`sourceOrderId` (= CardTrader order id). Articles are keyed by `sourceArticleId`, and the order
carries `isCtZero` / `isCtZeroClosing`. The merged order becomes a picking list with
`variant: "cardtrader_zero"` ("Ct Zero closed", which can't be deleted). Source: the Power Tools
3.10.0 bundle in `~/Projects/candyext/dump` (`Order`/`OrderArticle` models).

So Pokoin reads the same list directly from CardTrader with the seller's connected
CardTrader token: `GET /orders?order_as=seller&state=paid` and `&state=hub_pending`,
keeping `via_cardtrader_zero === true`. `closed` sources and direct orders are ignored,
so no item is counted twice.

Not verified on live data yet: the 17 Sep dump and the owner's Power Tools accounts
(2026-10-01) have no Zero orders (`/api/user/order` → `[]`). The first seller with a
Zero week should compare `/mypokoin/zero` with CardTrader's Zero page and with the Power
Tools Thursday list.

## `GET /api/cardtrader-zero`

Firebase bearer, seller must have CardTrader connected (`404 cardtrader_not_connected`).
Returns `weekly[]` (merged orders with `items[]`), `pending.items[]`, `totals`, and
`powerTools`. Each line has the CardTrader order/item/product/blueprint ids, name,
expansion, collector number, condition/language (blank when CardTrader has none, per
D00000F), quantity, seller price, and:

- `location`: the seller's MyPokoin location from the linked
  `marketplace_user_listings` row (`source_listing_id = ct:<product_id>`);
- `powerTools`: Power Tools order state, picked quantity, location, and bin, when a
  Power Tools session is connected.

Lines sort by location (natural order, located first), then set, collector number, and name.
The page's "picked" ticks are kept per browser in `localStorage`. They are a picking aid,
not shared state.

## Power Tools session

Power Tools has no OAuth for third-party apps. Its own sign-in is Outseta
(`POST https://mtg-powertools.outseta.com/api/v1/tokens`, form `username`/`password`
→ `access_token`, or a two-factor challenge), then
`POST https://new.tcgpowertools.com/api/auth/login {accessToken}` → `Set-Cookie: jwt=…`.
That `jwt` cookie is the whole session (no CSRF, no bearer).

`POST /api/powertools-connect` does the same with `{email, password}`. It also accepts
`{session}`, a pasted `jwt` cookie, for Google or two-factor accounts. It validates
against `GET /api/user` and stores only the session, AES-GCM encrypted with
`CARDTRADER_TOKEN_ENCRYPTION_KEY`, on `seller_integrations/{uid}__powertools`.

- The password is never stored or logged; request bodies are never logged.
- Power Tools' `/api/user` returns the seller's CardTrader OAuth and refresh tokens
  (`assignedCardtraderUser`). Only `_id`, `username`, `cardtraderUserId`, and
  `cardtraderUserName` are kept. `cardtraderMatch` warns when that CardTrader seller differs
  from the one connected to Pokoin.
- Failed password sign-ins are capped at 5 per hour per Pokoin user (`429`).
- An expired session never fails the CardTrader list. The overlay reports
  `powertools_session_expired` and the page asks the seller to sign in again.
- `DELETE` forgets the session.

Power Tools session JWTs carry `iat`/`exp` in milliseconds, and the server accepted a
13-day-old session on 2026-10-01. Treat a stored session as long-lived: that is why it
is encrypted and why it can be deleted.

## Deploy

All four runtime files ship in `scripts/deploy-cardtrader-sync-api.sh` (with
`_cardtrader_zero.test.js` and `powertools-connect.test.js`). The script health-checks
both new routes for `401` without a bearer. The SPA page ships with the web deploy.
