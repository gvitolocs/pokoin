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
- `market/src/deal-book.js`: what the Best Deal panel shows in the space left under its chips (tested in
  `deal-book.test.js`) — which listings count as the other sellers of the picked facet, the `See all N listings`
  count, which book rows show and in what order, and how many whole rows of each fit a measured height
  (`DEAL_BOOK_METRICS`, the same numbers `styles.css` sizes `.deal-book` from).
- `solid/src/components/desk/OfferBar.jsx`: the offer bar inside the Best Deal panel, directly above Add to cart (or at
  the bottom of the panel when nobody lists the card). It is as big as Add to cart and has three segments:
  `[⇄ Offer <best price>] [Beat offer | Make offer] [gear]`. Nothing ever expands inside the panel; only the one-line
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
- **Book rows** (`solid/src/components/deal/DealBook.jsx`) fill the space the chips leave above the bar, between them and
  `deal-actions`, with two blocks — **Other sellers** and **Buy offers**, each headed by a `.shop-label` (the seller
  icon, the two-tone BuySell mark) and each rendering nothing at all when it has no row, so a card with neither looks
  exactly as it did. `Other sellers` are the next-cheapest Pokoin listings of the facet the chips picked — never the
  listing Best Deal shows, never Vault stock — drawn as real `ShopListingRow`s in `compact` mode, so the price, the
  copies picker, the cart button and the own-listing edit/cancel actions are the Shop's, not a copy of them. Under them
  `See all N listings` scrolls to the Shop panel and moves focus to its header row; it is hidden when Best Deal plus
  these rows already cover every Pokoin listing. `Buy offers` is the book's `selectionBid` per grade for the picked
  language, best price first: the grade chip picks that facet (`setDealCond`, `setDealLang`), the price follows the
  bar's currency rule (`buyerParts(pkn, true, pinnedCurrency())`), the line says `N <grade> wanted`, and `Sell` — only
  on a grade with a `best_order_id` the visitor did not post (`buyOfferSellable`) — opens the bar's Define offer popup
  on that grade, where the existing Sell now form and its `best_remaining` cap live. Nothing expands inside the panel.
- **The book never grows the panel.** Above 1100px the stretched column has spare height under the chips, so `.deal-book`
  is the flex child that eats it (`flex: 1 1 0; min-height: 0; overflow: hidden`) — a scroll container contributes no
  minimum height of its own, which is what keeps Best Deal from ever outgrowing the centre column — and `DealBook`
  measures its `clientHeight` (plus `--deal-book-row/-gap/-head/-more/-block`, read back with `getComputedStyle` so CSS
  and `DEAL_BOOK_METRICS` cannot drift) and asks `planDealBook()` for whole rows only: the two lists alternate, each
  heading and the See all line is reserved before it is drawn, and a list with no row is dropped so the other takes the
  space. The whole list is `.deal-book-list { display: flex }`, never a grid — a grid row takes the tallest cell, and a
  row would then cost more than it is charged. At 1100px and below the desk stacks and nothing is measured:
  `dealBookUncut()` caps each list at three rows, two at 720px and below, plus the See all line, so a stacked panel is
  never clipped.
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
