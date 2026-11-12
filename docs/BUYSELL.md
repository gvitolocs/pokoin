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
- `solid/src/lib/buy-book.js`: the desk's one buy-order book. It loads `GET /api/marketplace-buy-book?card_id=` once,
  after the listings and at idle, and hands the same signal to the offer bar and to the book rows, so the panel never
  asks twice. It also keeps the ids posted from this page (`mine`): the book never names a buyer, so that list is what
  stops your own offer coming back as Sell. If the request fails the book is `null` and neither surface is drawn;
  `?mypokoinPreview` serves the fixture book and makes no request.
- `market/src/deal-book.js`: what the two listing cells show (tested in `deal-book.test.js`) — the three cheapest Pokoin
  listings across *every* condition and language for the summary cell, the `See all N listings` count, which buy-order
  rows show and in what order for the offers cell, and `DEAL_BOOK_PHONE_MAX_WIDTH`, the width the desk restacks at and
  therefore the width below which each cell shows two rows instead of three.
- `solid/src/components/desk/OfferBar.jsx`: the offer bar in the Best Deal band, on its action line beside Add to cart.
  It is as big as Add to cart and has three segments:
  `[⇄ Offer <best price>] [Beat offer | Make offer] [gear]`. Nothing ever expands inside the band; only the one-line
  confirmation or error under the bar changes its height.
  - **Beat offer** (an offer exists for the selection) is one press: it posts one step above the best offer
    (`beatPricePkn`: 1%, rounded up, at least 1 PKN) with the choices made in Define offer. Its `title` says exactly what it posts
    ("Offer 3.83 DKK for 1 copy, Near Mint, EN, 30 days"), it is disabled while the request runs, and success shows
    "Offer posted at <price>." with **Undo**, which cancels that order and refetches. Signed-out visitors go to sign-in.
    `duplicate_buy_order` shows "You already have an offer on this card. Change it in Define offer." and opens the popup.
  - **Make offer** (no offer yet) and the **gear** (labelled "Define offer") open the Define offer popup with the price field focused. The popup is a
    portal in `<body>`, anchored to the bar (a bottom sheet at 720px and below), closing on Escape, a click outside and its
    own close button, with focus moving in and returning to the gear. It holds price, copies, condition, language, Open for,
    Reverse / 1st Ed., the "listing already available" note, Post offer, Cancel and, when a live best offer that is not the
    visitor's own exists, Sell now.
  - **Choices in Define offer** (copies, condition, language, days, Reverse, 1st Ed.) live in memory for the page and drive Beat offer.
    Defaults: 1 copy, the Best Deal's condition and language, 30 days. A new condition or language chip clears the two
    settings that follow the chips.
  - **Currency:** the price field is in the visitor's display currency (`buyerCurrency(pinned)`: the `?currency=` pin, else
    the account country's), labelled "Price (DKK)". `offerPricePkn` / `offerPriceInput` in `buy-orders.js` wrap
    `listingPriceToPkn` and `priceInputFromPkn`, the listing form's own conversion, so the two forms agree. Labels and
    notes use `offerPriceLabel` (the listing form's "Lists at" formatter); a PKN display currency shows PKN.
  - The book loads after the listings (`lib/buy-book.js`, at idle) once for the whole desk; if the request fails the book
  is `null`, and with it the bar and the Buy offers rows.
- **The desk is one grid** (`market/src/styles.css`, pinned by `card-desk-layout.test.js`):

  ```
  [ art ] [ band:  Best Deal · price + chips · offer bar + Add to cart ]
  [ art ] [ graph: sold prices            ] [ form: List your card     ]
  [ art ] [ cheap: Cheapest listings      ] [ offers: Buy offers       ]
  ```

  The art column spans all three rows and is the only element that does. Rows size to their content: the two listing
  cells and the form hug what they paint, and only the graph stretches, so the taller of a row pair never leaves the
  other with a hole inside its own box. The Vault and the expanded Shop are **not** grid areas — they auto-place as
  full-width rows (`grid-column: 1 / -1`) under the third row, because a named area that renders nothing would still
  cost its track and its gap. Below 1000px the graph, the form and both cells take the whole desk and the art column
  stops spanning (beside five stacked rows it would be one long empty strip); at 720px the desk restacks to
  art, band, cheap, offers, graph, form.
- **The band** (`solid/src/pages/Card.jsx`, `.desk-band`) is one horizontal strip. Its head line carries the
  `.shop-label` "Best Deal" and the marketplace pills at the top-left; the first content line the price stack (large
  local, small PKN, `Sold by …` under it) with the condition and language chips beside it; the second the offer bar and
  Add to cart, right-aligned. The chips fold inside their own box instead of pushing a third line, so the band is two
  content lines at every desktop width. With no Pokoin listing (for the card at all, or for the picked condition and
  language) the price slot shows the dash `—`, never a sentence; its hover text says which. The action line still
  carries the offer bar.
- **The sold graph** (`solid/src/components/desk/SoldPriceGraph.jsx`) follows the chips and has no menus of its own.
  Every condition / language / Reverse combination the visitor picks stays on it as its own line with a legend entry
  and a remove button, up to eight; the current pick is the one with the fill and the tooltip. Colours come from
  `soldSeriesColor` (`market/src/sold-graph.js`): the first language picked keeps the grade colours, each further
  language its own palette, Reverse is the same colour dashed. A series only has a point on a day it sold; between
  sales the line is straight, and before its first and after its last sale the price is carried flat to the edge of
  the visible range as a faint dashed segment. A pick that never sold is an empty graph that says so. The graph shows
  no unit counts.
- **Cheapest listings** (`solid/src/components/deal/CheapestListings.jsx`) is the page's listing summary: the three
  cheapest Pokoin listings across *every* condition and language, the one the band shows included, drawn as real
  `ShopListingRow`s in `compact` mode, so the price, the copies picker, the cart button and the own-listing edit/cancel
  actions are the Shop's, not a copy of them. Two rows on a phone. Under them `See all N listings` when there are more
  listings than shown; with no listing at all the cell keeps the old empty text and the market-price note.
- **Buy offers** (`solid/src/components/deal/BuyOffers.jsx`) is the book's `selectionBid` per grade for the picked
  language, best price first, three rows (two on a phone): the grade chip picks that facet (`setDealCond`,
  `setDealLang`), the price follows the bar's currency rule (`buyerParts(pkn, true, pinnedCurrency())`), the line says
  `N <grade> wanted`, and `Sell` — only on a grade with a `best_order_id` the visitor did not post (`buyOfferSellable`)
  — opens the bar's Define offer popup on that grade, where the existing Sell now form and its `best_remaining` cap
  live. With no orders the cell is still drawn: one line, `No buy offers yet.` and a `Make offer` text button that
  opens the same popup, so the desk never shows a blank box.
- **`See all` opens the full Shop in place**, as the desk's last row, and the line becomes `Hide the full shop`. The
  open state belongs to the page, not to the scroll position, and anything that walks the visitor to the Shop (a deep
  link, the header cart hint) opens it first — `scrollShop()` in `solid/src/pages/Card.jsx`. It never auto-expands:
  no URL carries a Shop filter or sort param today, so the "expanded when the URL already asks for one" case has no
  trigger.
- **The Vault row only exists with stock.** `split().vault.length` gates the whole panel at every width, which replaces
  the old `.vault-panel.is-empty` hiding rule; its tests assert the absence instead of the class.
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
without calling the API or signing in. Posting, Sell now, Edit and Cancel do nothing in preview. On the desk the
fixture book feeds both surfaces at once — the offer bar and the Best Deal Buy offers rows — while Other sellers
still comes from the card's real listings.
