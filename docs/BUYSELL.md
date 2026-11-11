# BuySell

BuySell is a board of standing buy offers. A signed-in buyer says "I will pay X PKN for this card, in this
condition and language, up to N copies, for D days", even when nobody lists the card. Anyone who owns the card
can press **Sell now**: that creates a normal listing by the seller at the offer price and tells the buyer, who
buys it through the cart. In the UI the buyer's thing is an *offer*; the API noun is *buy order*.

## Rules

- Version 1 is not binding and moves no money. The buyer pays only when they buy the listing.
- 1 to 10 copies per offer.
- Duration: 1, 7, 30, 60 or 90 days, or until cancelled. The form defaults to 30 days.
- One open offer per card + condition + language + reverse + 1st edition.
- At most 100 open offers per user.
- A seller cannot sell into their own offer.
- An offer at or above the cheapest listing shows "A listing at X is already available. You can buy it now."; it can still be posted.

## States

`open`, `filled`, `expired`, `cancelled`. Selling into an offer lowers its remaining copies; at 0 it is `filled`.

## API (`/api/marketplace-buy-orders`)

| Call | Auth | Purpose |
| --- | --- | --- |
| `GET ?card_id=` | public | Book for one card: best price, copies and offers per facet tuple. |
| `GET /board?limit=&sort=recent\|price&before=` | public | Open offers, newest or highest price first, cursor in `next`. |
| `GET /mine` | yes | The caller's offers with `state` and `fills`. |
| `GET /for-my-listings` | yes | Open offers that match the caller's active listings. |
| `POST /` | yes | Create an offer. `409 duplicate_buy_order`, `409 too_many_buy_orders`. |
| `PATCH /{id}` | yes | Change `price_pkn`, `quantity` or `days`. |
| `DELETE /{id}` | yes | Cancel. |
| `POST /{id}/sell` | yes | Sell now: `{ quantity }` → `201 { listing_id, buy_order }`. `403 own_buy_order`, `409 not_open`, `409 quantity_exceeds_remaining`. |

The card tile's Sell now needs the id of the best order, so each book row may carry `best_order_id`; without it
the tile hides Sell now (the board and the Sell to buyers tab always have ids).

## Where the UI lives

- `market/src/buy-orders.js`: client calls and the pure helpers (tested in `buy-orders.test.js`).
- `solid/src/components/desk/BuyOrdersTile.jsx`: the "Buy offers" panel under Best Deal on the card page. It
  follows the desk's condition and language, loads after the listings, and hides itself if the book request fails.
- `solid/src/components/buysell/SellNowForm.jsx`: the Sell now flow shared by the tile and the page.
- `solid/src/pages/BuySell.jsx`: `/buysell` with tabs Wanted, My offers (`?tab=mine`), Sell to buyers (`?tab=sell`).
- Navigation: the two-arrows icon (`market/src/buysell-icon.js`) in Chrome, the phone menu and the footer.
- Edge: `/buysell` is an SPA prefix in `scripts/write-cloudflare-web-routing.mjs` and has rewrites in `vercel.json`.
