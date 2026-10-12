# Seller API: grants, connector and webhooks

How an inventory app (Card Rails, or any other platform) keeps a seller's
Pokoin stock in step and hears about their sales. It works like a CardTrader
API application: a token, a shared secret, a webhook URL and signed events.

Source: `pokoin-rust/crates/commerce/src/seller_api.rs` (tokens, event log,
delivery worker) and `handlers/seller_api.rs` (routes). Schema:
`scripts/sql/115_seller_api_grants.sql`.

## The token is not a sign-in

| | Sign-in | Seller API grant |
| --- | --- | --- |
| What it is | Firebase ID token | `pkn_` + 43 characters, created in Profile → **Card Rails & API tokens** |
| Lifetime | 1 hour, refreshed by the app | Until the seller revokes it |
| Can do | Everything the seller can | Read and set stock, list cards, read sales, set its webhook |
| Cannot do | — | Spend or move PKN, read buyers or addresses, change the account, create tokens |
| Stored as | Not stored | sha256 only; shown once at creation |

A grant is never accepted where a sign-in is required, and the reverse. It is
unrelated to the seller's CardTrader API token, which Pokoin only ever sends
to CardTrader.

Scopes: a grant created for Card Rails has `cardrails:stock`; any other app
gets `seller:stock`. A seller holds at most 10 live grants.

"Accedi con Pokoin" in Card Rails also issues one: the Card Rails API passes
`"grant": true` to `POST /api/cardrails-token`, and the answer carries
`grant` (`pkn_…`) next to the identity. It is a `cardrails` grant labelled
**Accedi con Pokoin**; each sign-in revokes the previous one, and a seller
already at 10 hand-made grants gets the identity without a grant. The shared
secret is sealed with `CARDTRADER_TOKEN_ENCRYPTION_KEY`, so the Pi API needs
that variable (it already has it for CardTrader).

## Managing grants (signed-in seller)

`GET /api/seller-api-grants` → `{ grants: [{ id, client, label, scope, tokenPrefix, webhookUrl, createdAt, lastUsedAt }] }`

`POST /api/seller-api-grants` with `{ action, … }`:

| action | Body | Result |
| --- | --- | --- |
| `create` | `client` (app name), `label` | `{ grant, token, sharedSecret }` — the only time the token is returned |
| `revoke` | `id` | The token stops working at once; its undelivered webhooks are dropped |
| `webhook` | `id`, `url` | Sets the webhook URL by hand (empty clears it) |
| `test` | `id` | Queues a `webhook.test` event for that grant |

## Connector (the app, with its grant)

`POST /api/cardrails/connector` — `cardrails:stock` grants only. This is the
URL Card Rails is configured with (`POKOIN_CARDRAILS_CONNECTOR_URL`).

`POST /api/seller-api/v1` — any grant. Same body, same answers.

Header `Authorization: Bearer pkn_…`, JSON body `{ "action": … }`:

| action | Body | Answer |
| --- | --- | --- |
| `connect` / `info` | — | `{ scope, client, accountRef, accountName, cardmarketLinked: false, webhookUrl, sharedSecret, locations }` |
| `scan-settings` | — | `{ batchId, scanSettings }` — latest open (otherwise latest submitted) scan batch defaults, normalized for Card Rails; read-only and seller-scoped. Includes game, language, finish, condition, flags, quantity, merge policy and the exact location/stack/start position. |
| `locations` | — | `{ locations: [{ label }] }` — storage locations on the seller's live stock |
| `webhook` | `url` | `{ webhookUrl, sharedSecret }` — like CardTrader's `PATCH /app` |
| `listings` | `cursor?`, `limit?` (≤ 500) | `{ listings: [{ listingId, cardId, game, name, setName, collectorNumber, condition, language, quantity, status, pricePkn, priceEurCents, reverse, firstEdition, foilState, location, updatedAt }], cursor }` |
| `stock` | `listingId`, `targetQuantity` (0–99), `channel?` | `{ confirmed: true, listingId, quantity, status, changed }` |
| `list` | `item`, `idempotencyKey`, `channel?` | `{ confirmed: true, listingId, stockMode: "absolute", created }` |
| `sales` | `cursor?` | `{ orders: [order], sales: [{ channel, externalId, quantity, orderRef, lineId, occurredAt }], cursor, more }` — order events only; `sales` are the paid orders' lines, `externalId` being the listing id |
| `events` | `cursor?` | `{ events: [envelope], cursor, more }` — everything |

Rules worth knowing:

- **Stock is absolute.** `stock` sets the quantity; repeating the call changes
  nothing (`changed: false`). `0` pauses the listing, and stock returning to a
  listing that ran out puts it back on sale. A listing the seller paused with
  stock on it stays paused. A removed listing answers `409 listing_removed`.
- **`list` creates at most once per `idempotencyKey`.** A repeat returns the
  same `listingId` with `created: false`. If an earlier attempt died halfway
  the answer is `409 list_in_doubt`: read `listings` instead of retrying.
  `item` is the Card Rails inventory item: `identity.publicId` is the Pokoin
  card id (required), `price` is EUR (200 PKN per euro) or pass `pricePkn`,
  `quantity`, `condition`, `language`, `finish`, `location`.
- **`channel`** is `pokoin` or absent. `cardmarket` answers
  `409 cardmarket_unlinked`: Pokoin has no Cardmarket account link.
- Another seller's listing is `404`, exactly like one that does not exist.

## Events and webhooks

Every stock change and paid order of a seller with a live grant is appended to
`seller_api_events`. Each grant with a webhook URL gets it posted:

```http
POST <webhook url>
Content-Type: application/json
Signature: <base64 HMAC-SHA256 of the raw body, keyed with the grant's shared secret>
X-Pokoin-Event: order.create
X-Pokoin-Delivery: 4812

{"id":"order.create:ORDER","time":1760000000,"cause":"order.create",
 "object_class":"Order","object_id":"ORDER","mode":"live","data":{…}}
```

The envelope and the `Signature` header are CardTrader's, so a receiver that
already verifies CardTrader webhooks verifies these with the same code. Verify
over the **raw** body; re-serialized JSON does not match.

| cause | When | `data` |
| --- | --- | --- |
| `listing.create` | A listing is created | `listing_id`, `card_id`, `game`, `quantity`, `status`, `price_pkn`, `condition`, `language`, `name`, `set_name`, `collector_number`, `mutation` |
| `listing.update` | Quantity, price or status changed, sold out included | same |
| `listing.destroy` | The listing was removed | same |
| `order.create` | An order is paid | `id`, `code`, `state: "paid"`, `paid_at`, `currency`, `order_items: [{ id, listing_id, card_id, name, quantity, unit_price_pkn, condition, language }]` — this seller's lines only, never the buyer |
| `order.destroy` | The seller refunded the order | `id`, `code`, `state: "canceled"`, `cancelled_at` |
| `webhook.test` | The seller pressed **Send test** | `grant_id` |

Delivery: answer `2xx` within 10 seconds. Anything else is retried with
backoff (30 s, 2 min, 8 min, … up to 8 attempts over about two days).
Redirects are not followed. Events are kept 90 days.

**A webhook is a hint, not the record.** Read `sales` (or `events`) with the
last cursor on a timer, as with CardTrader's `GET /orders`. An event carries a
stable `id`; dedupe on it, since a retried webhook and a cursor read deliver
the same event twice. A tool's own `stock` call comes back as a
`listing.update` with the quantity it set, which is safe to apply.

Webhook URLs must be `https` on the default port to a named public host. IP
literals, credentials in the URL and local names are refused, and the request
is pinned to a public address resolved at delivery time.

## Operations

- Migration `115_seller_api_grants.sql` goes on the nezopt writer first. Until
  it is applied the routes answer `503 seller_api_disabled` and the listing
  outbox and order paths carry on unchanged.
- Shared secrets are encrypted with `CARDTRADER_TOKEN_ENCRYPTION_KEY`, the key
  the CardTrader integration already uses.
- `POKOIN_SELLER_WEBHOOK_WORKER=0` stops the delivery worker on an instance.
  Several instances share the queue (`for update skip locked`).
- A delivery that used its 8 attempts logs `seller_webhook_dead_letter`.
- End-to-end test: `pokoin-rust/crates/commerce/tests/seller_api_flow.rs`
  (needs `POKOIN_TEST_DATABASE_URL`; the header of the file has the command).
