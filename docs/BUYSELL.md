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

Each book row carries `best_order_id` and `best_remaining`, the copies left on that one order. The card page's Sell
now needs both: it caps the quantity at `best_remaining` (the row's `quantity` is the total over all its orders and
can be larger). Without `best_order_id` the offer bar hides Sell now (the board and the Sell to buyers tab always have ids).

Errors are `{ "error": "<code>", "code": "<code>" }`; `duplicate_buy_order` also carries the existing order's `id`.
`POST` needs the `days` key (`null` is until cancelled) and takes an optional `buyer_name`, the buyer's public
display name. Languages are the 16 codes of the price book (the listing form's `LIST_LANGS`); the form offers no other.

## Where the UI lives

- `market/src/buy-orders.js`: client calls and the pure helpers (tested in `buy-orders.test.js`).
- `solid/src/components/desk/OfferBar.jsx`: the offer bar inside the Best Deal panel, directly above Add to cart (or at
  the bottom of the panel when nobody lists the card). It is as big as Add to cart and has three segments:
  `[⇄ Offer <best price>] [Beat offer | Make offer] [gear]`. Nothing ever expands inside the panel; only the one-line
  confirmation or error under the bar changes its height.
  - **Beat offer** (an offer exists for the selection) is one press: it posts one step above the best offer
    (`beatPricePkn`: 1%, rounded up, at least 1 PKN) with the offer settings. Its `title` says exactly what it posts
    ("Offer 3.83 DKK for 1 copy, Near Mint, EN, 30 days"), it is disabled while the request runs, and success shows
    "Offer posted at <price>." with **Undo**, which cancels that order and refetches. Signed-out visitors go to sign-in.
    `duplicate_buy_order` shows "You already have an offer on this card. Change it in the settings." and opens the popup.
  - **Make offer** (no offer yet) and the **gear** open the settings popup with the price field focused. The popup is a
    portal in `<body>`, anchored to the bar (a bottom sheet at 720px and below), closing on Escape, a click outside and its
    own close button, with focus moving in and returning to the gear. It holds price, copies, condition, language, Open for,
    Reverse / 1st Ed., the "listing already available" note, Post offer, Cancel and, when a live best offer that is not the
    visitor's own exists, Sell now.
  - **Settings** (copies, condition, language, days, Reverse, 1st Ed.) live in memory for the page and drive Beat offer.
    Defaults: 1 copy, the Best Deal's condition and language, 30 days. A new condition or language chip clears the two
    settings that follow the chips.
  - **Currency:** the price field is in the visitor's display currency (`buyerCurrency(pinned)`: the `?currency=` pin, else
    the account country's), labelled "Price (DKK)". `offerPricePkn` / `offerPriceInput` in `buy-orders.js` wrap
    `listingPriceToPkn` and `priceInputFromPkn`, the listing form's own conversion, so the two forms agree. Labels and
    notes use `offerPriceLabel` (the listing form's "Lists at" formatter); a PKN display currency shows PKN.
  - The book loads after the listings (props.ready); if the request fails the bar is not drawn.
- Best Deal's two-line price is flipped (`PriceStack flip`, order in `market/src/price-stack.js`): the local currency is the
  large yellow figure and the PKN amount the small line above it. A single price is unchanged. Tiles, shop rows, search and
  cart keep the old order.
- `solid/src/components/buysell/SellNowForm.jsx`: the Sell now flow shared by the offer bar popup and the page.
- `solid/src/pages/BuySell.jsx`: `/buysell` with tabs Wanted, My offers (`?tab=mine`), Sell to buyers (`?tab=sell`).
- Navigation: the two-tone BuySell mark (`market/src/buysell-icon.js` paths, drawn by `components/buysell/BuySellIcon.jsx`; buy arrow `--buysell-buy` = `--yellow`, sell arrow `--buysell-sell` = `--ct-blue`; also next to the page title and in the offer bar) in Chrome, the phone menu and the footer.
- Edge: `/buysell` is an SPA prefix in `scripts/write-cloudflare-web-routing.mjs` and has rewrites in `vercel.json`.

## Preview

`?mypokoinPreview` on a card page or on `/buysell` (the MyPokoin switch: dev build, or host `localhost` /
`127.0.0.1`; never on a production host) shows fixture offers from `solid/src/pages/buysell-preview-fixture.js`
without calling the API or signing in. Posting, Sell now, Edit and Cancel do nothing in preview.
