# BuySell

> On screen the feature is called **CardGTS** (page `/cardgts`; `/buysell` still opens it). Code, files and API paths keep the BuySell name.

BuySell is a board of standing buy offers. A signed-in buyer says "I will pay X PKN for this card, in this
condition and language, up to N copies, for D days", even when nobody lists the card. Anyone who owns the card
can press **Sell**: that opens **Quick Sell**, which creates a normal listing by the seller at the offer price and
tells the buyer, who buys it through the cart. In the UI the buyer's thing is an *offer*; the API noun is *buy order*.

## Rules

- Version 1 is not binding and moves no money. The buyer pays only when they buy the listing.
- 1 to 10 copies per offer.
- Duration: 1, 7, 30, 60 or 90 days, or until cancelled. The form defaults to 30 days.
- One open offer per card + condition + language + reverse + 1st edition.
- At most 100 open offers per user.
- A seller cannot sell into their own offer.
- An offer at or above the cheapest listing shows "A listing at X is already available. You can buy it now."; it can still be posted.
- **Selling never opens the Define offer popup.** The popup is the buyer's side of the trade (price, copies, condition,
  Open for); a Sell press opens Quick Sell on the exact offer that was pressed, with nothing to configure but the
  copies and one optional note.
- **A seller's note is private to the buyer.** It is sent with the notification and stored on the fill; it is never in
  the public book, the board, the listing, or any `sellerComment` field, and only the buyer who owns the order reads it
  back on `/buysell?tab=mine`. Pokoin's starting offer has no buyer to write to, so that note goes to Pokoin's mail
  only. Maximum 240 characters (`BUYER_MESSAGE_MAX`), counted as code points after folding `\r\n` and trimming;
  control characters are refused.

## States

`open`, `filled`, `expired`, `cancelled`. Selling into an offer lowers its remaining copies; at 0 it is `filled`.

## API (`/api/marketplace-buy-orders`)

| Call | Auth | Purpose |
| --- | --- | --- |
| `GET ?card_id=` | public | Book for one card: best price, copies and offers per facet tuple. |
| `GET /board?limit=&sort=recent\|price&before=` | public | Open offers, newest or highest price first, cursor in `next`. |
| `GET /mine` | yes | The caller's offers with `state` and `fills`; a fill may carry `seller_message`, the note that seller chose. |
| `GET /for-my-listings` | yes | Open offers that match the caller's active listings. |
| `POST /` | yes | Create an offer. `409 duplicate_buy_order`, `409 too_many_buy_orders`. |
| `PATCH /{id}` | yes | Change `price_pkn`, `quantity` or `days`. |
| `DELETE /{id}` | yes | Cancel. |
| `POST /{id}/sell` | yes | Sell into one order: `{ quantity, buyer_message? }` → `201 { listing_id, buy_order }`. `403 own_buy_order`, `409 not_open`, `409 quantity_exceeds_remaining`, `409 buy_order_changed`, `400 invalid_buyer_message`. |
| `POST /house/sell` | yes | Sell into Pokoin's starting offer: the facets, `{ quantity, buyer_message?, card_name, card_image_url, set_name, collector_number }` → `201 { listing_id }`. |

`buyer_message` is sent **only when there is something to send**: an empty or whitespace-only note is left out of the
body entirely, and a note with Windows line breaks is sent folded to `\n` and trimmed — the same text the dialog's
counter shows (`buyerMessageText` / `buyerMessageLength` / `buyerMessageError` in `market/src/buy-orders.js`). An older
API that ignores the field still gets a listing: the note is optional, so nothing about the sale changes.

Each book row carries `best_order_id` and `best_remaining`, the copies left on that one order. Quick Sell needs both:
it caps the copies at `best_remaining` (the row's `quantity` is the total over all its orders and can be larger).
Without `best_order_id` nothing is sellable (the board and the Sell to buyers tab always have ids). Sellers' own
offers are hidden by `buyOfferSellable`, which the book cannot do alone because it names no buyer.

Errors are `{ "error": "<code>", "code": "<code>" }`; `duplicate_buy_order` also carries the existing order's `id`.
`POST` needs the `days` key (`null` is until cancelled) and takes an optional `buyer_name`, the buyer's public
display name. Languages are the 16 codes of the price book (the listing form's `LIST_LANGS`); the form offers no other.

Storage: `scripts/sql/143_buy_order_fill_seller_message.sql` adds `marketplace_buy_order_fills.seller_message`, one
private line per fill, capped at the same 240 characters. It is written by the two sell calls and read only by
`GET /mine`; nothing else selects it.

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
    Reverse / 1st Ed., the "listing already available" note, Post offer and Cancel. Nothing on the seller's side is in
    it: a Sell press opens Quick Sell from the desk, and the popup no longer reads a sell intent at all.
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
  — opens Quick Sell on that row. With no orders the cell is still drawn: one line, Pokoin's starting offer, a `Sell`
  link into it and a `Make offer` text button that opens the Define offer popup, so the desk never shows a blank box.
- **Quick Sell** (`solid/src/components/buysell/QuickSellDialog.jsx`) is the whole sell path in one modal: a centred
  card up to 26rem, the same bottom sheet as the Define offer popup at 720px and below. It shows the card with one
  facet line (`NM · EN`, plus `Reverse` / `1st Ed.`), the locked price of the target in the unit the visitor picked for
  offers (`storedOfferUnit`, so the dialog and the popup never disagree), the buyer's handle where the caller knows one
  (the board does; the book names nobody, so the desk says `A buyer`), a copies stepper capped by that order's
  `best_remaining`, and the optional note with its live counter. `List at <price>` posts once and the button reads
  `Listing…`; the same dialog then replaces the form with `Listed at <price>. The buyer will be notified.` (Pokoin's
  starting offer: `Pokoin will be notified.`) and `See your listings`. Nothing there claims a sale, a payment or a
  delivered mail — a listing is a listing.
  - It opens from exactly four places: the **Buy offers row** `Sell`, the empty cell's **starting-offer** `Sell`, the
    **"Have this card?" strip** on the desk, and the **`/buysell`** Wanted board and `?tab=sell` rows
    (`components/buysell/SellNowForm.jsx`, the trigger on a board row). None of them opens the Define offer popup.
  - `sellTarget(row, facets)` in `solid/src/lib/buy-book.js` is the one builder of a target, and it is complete at the
    click: a book row's own `best_order_id` / `best_remaining` / `best_price_pkn` and its own facets, or Pokoin's
    starting offer with the facets the desk shows. Selling therefore never waits for a chip to move, which is what the
    old path did when it wrote the grade into the popup and opened it.
  - A `409` (`not_open`, `quantity_exceeds_remaining`, `buy_order_changed`) keeps the form open with the plain sentence
    and reloads the book or board so the cap is fresh; a `401` goes to sign-in; `invalid_buyer_message` says
    `That note is too long or has characters we can't send.`
  - A11y: `role="dialog"`, `aria-modal`, labelled by its own title, focus moves into the container and back to the Sell
    button that opened it (not on the phone sheet, which covered it), Tab is trapped, Escape and a press outside close
    it — never while a post is in flight — the body does not scroll behind it, and `prefers-reduced-motion` drops the
    slide-in. Every control is at least 40px.
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
- `solid/src/components/buysell/SellNowForm.jsx`: the `Sell now` button on a `/buysell` row, and nothing else — it builds
  the target, sends a signed-out visitor to sign-in, and mounts the dialog. `solid/src/lib/buy-book.js` is the desk's
  one `pickSell(target)` / `sellPick` signal, keyed by a counter so the same row twice is a fresh dialog.
- `solid/src/pages/BuySell.jsx`: `/buysell` with tabs Wanted, My offers (`?tab=mine`), Sell to buyers (`?tab=sell`).
- Navigation: the two-tone BuySell mark (`market/src/buysell-icon.js` paths, drawn by `components/buysell/BuySellIcon.jsx`; buy arrow `--buysell-buy` = `--yellow`, sell arrow `--buysell-sell` = `--ct-blue`; also next to the page title and in the offer bar) in Chrome, the phone menu and the footer.
- Edge: `/buysell` is an SPA prefix in `scripts/write-cloudflare-web-routing.mjs` and has rewrites in `vercel.json`.

## Preview

`?mypokoinPreview` on a card page or on `/buysell` (the MyPokoin switch: dev build, or host `localhost` /
`127.0.0.1`; never on a production host) shows fixture offers from `solid/src/pages/buysell-preview-fixture.js`
without calling the API or signing in. Posting, Edit and Cancel do nothing in preview. Quick Sell still opens and
paints its real form, but `props.preview` skips sign-in and the request and takes the dialog straight to its success
state, so the sheet that gets reviewed is the one a real sale ends on. On the desk the
fixture book feeds both surfaces at once — the offer bar and the Best Deal Buy offers rows — while Other sellers
still comes from the card's real listings.
