# TCGplayer sync box

Status: server side, worker core, and browser portal (2026-10-16). The browser
portal is tested only against a local mock. Its Seller Portal selectors are
**unverified until the seller runs `check` and calibrates `--portal-config`**.
See [Terms and account risk](#terms-and-account-risk) and
[First live run](#first-live-run).

TCGplayer gives sellers no write API. New API keys are no longer issued
(docs.tcgplayer.com "Getting Started": "We are no longer granting new API
access at this time"). SortSwift works around this with a "Sync Box": a
machine the seller owns, signed in to the Seller Portal in a real browser,
that applies listings, quantities and prices and reads orders back. This doc
is the Pokoin equivalent.

## Terms and account risk

Read on 2026-10-15:

- TCGplayer Terms of Service (updated 2023-09-27): "You agree not to crawl,
  scrape or spider any of our websites without express permission from us."
  Reading orders out of Seller Portal pages is that kind of automated reading.
- The same terms: TCGplayer "reserves the right to terminate a user's
  participation … at any time for any reason at its sole discretion, with or
  without notice."
- Marketplace Seller Agreement (updated 2024-04-25): no clause on bots or
  automation was found. It says a seller may not share the password except
  with authorized employees, and buyer information stored outside the Seller
  Portal must be kept where unauthorized people cannot reach it.

Neither page explicitly bans automating your own Seller Portal for writes.
But order pull is close to the scraping clause, and termination is at
TCGplayer's discretion. A box that makes many fast, regular, machine-shaped
requests is what anti-abuse systems look for. **The risk is the seller's
TCGplayer account: suspension or closure, with held payouts.** SortSwift
shipping this does not make it permitted. The way to remove the risk is
written permission from TCGplayer seller support, or a Pro/API partner
arrangement.

The low-risk mode that needs no browser automation is CSV (below). It uses
TCGplayer's own bulk upload and order export, and Pokoin already reads and
writes the TCGplayer CSV format (`pokoin-rust/crates/commerce/src/domain/stock_csv.rs`,
`TCGPLAYER_HEADERS`).

## Pieces

```text
Pokoin API (pokoin-rust, commerce crate)              seller's box
┌──────────────────────────────────────┐   HTTPS    ┌──────────────────────────────┐
│ listing outbox (listing.changed)     │            │ tcgplayer-sync-box (Rust)    │
│   └─ channel step → channel_sync_jobs│◀── claim ──│   heartbeat every 30 s       │
│ seller_channel_devices (enable, beat)│◀─ beat ────│   claim → Portal → complete  │
│ channel_listing_links (listing↔SKU)  │◀ complete ─│   Portal trait:              │
│ channel_orders (merged orders view)  │◀─ orders ──│     FakePortal (tests)       │
│ channel_price_rules (base ± per chan)│            │     BrowserPortal / CsvPortal│
└──────────────────────────────────────┘            │   browser profile stays here │
                                                    └──────────────────────────────┘
```

The box authenticates with a **seller API grant** (`seller_api_grants`,
`pkn_…` bearer, sha256-stored) with client `tcgplayer-sync-box` and scope
`channel:tcgplayer`. The seller creates it from Profile, the token is shown
once, and revoking the grant cuts the box off on its next request. No new
credential scheme.

## Credentials: what the box never touches

- The seller signs in to TCGplayer themselves, in the box's Chrome window.
- The worker never asks for, reads, stores, logs, or types a TCGplayer
  username, email, password, or 2FA/OTP code. It never reads or exports
  cookies or storage, and never sends them to Pokoin.
- `type_into` refuses a password or email input, an autocomplete of password /
  username / email / one-time-code, and a name, id, or aria-label matching
  `pass`, `user`, `login`, `email`, `otp`, `2fa`, `mfa`, `code`, or `secret`.
  Price and quantity inputs are not in that list.
- `navigate` refuses any origin that is not in the portal config's
  `allowedOrigins`.
- The browser profile (cookies, local storage) lives only in the box's
  profile directory (`--profile-dir`, default `~/.local/share/pokoin-tcgplayer-box/profile`,
  mode 700). Deleting it signs the box out.
- When the Portal shows a sign-in page, the box reports `signedIn=false` and
  stops claiming. It does not try to sign in.
- A captcha or bot challenge is `Blocked`. The box does not solve, bypass, or
  wait-and-retry it. See [When the portal is blocked](#when-the-portal-is-blocked).

## Device registration, heartbeat, enable switch

`seller_channel_devices`: one live device per (seller, channel).

| Field | Meaning |
| --- | --- |
| `enabled` | the master switch. Off by default; the seller turns it on from Profile. |
| `grant_id` | the seller API grant the box uses. |
| `last_heartbeat_at` | set by every heartbeat. |
| `signed_in`, `running` | reported by the box with each heartbeat. |
| `worker_version`, `last_error` | for support. |

The box heartbeats every 30 s (`POST /api/channel-sync/device`,
`action: heartbeat`) and the reply says whether it is enabled. Status badges
(SortSwift's "Using a sync" / "Running" / "Signed in") come from
`GET /api/channel-sync?channel=tcgplayer`:

| Badge | Rule |
| --- | --- |
| `using_sync` | a live (not revoked) device exists and `enabled` |
| `online` | `last_heartbeat_at` within 90 s |
| `running` | online and the box reports `running` |
| `signed_in` | online and the box reports `signedIn` |

## Jobs

`channel_sync_jobs` rows. Job types:

| Kind | Made when | Carries |
| --- | --- | --- |
| `push_listing` | a listing becomes eligible and has no `channel_listing_links` row | listing id + absolute qty, channel price, SKU hint |
| `set_qty` | quantity or status changes (sold, paused, deleted → qty 0) | listing id + absolute qty |
| `set_price` | `price_pkn` or the seller's TCGplayer price rule changes | listing id + absolute USD cents |
| `pull_orders` | scheduled by the box (every 10 min) and by "Sync now" | since cursor |
| `full_resync` | the switch goes from off to on | recorded, fanned out at enable into per-listing set_qty jobs; set_qty on an unlinked listing is sent as push_listing |

**Targets are absolute, never deltas.** A job says "this SKU has 3 at $12.40",
not "minus 1". A job that runs twice, or after a crash, writes the same
state. Delta writes are only used for CardTrader (`increment`) because
CardTrader has an API that counts its own sales; the Portal does not give
that guarantee.

**Target is read at claim time.** The row remembers which listing is dirty;
`claim` computes qty and price from the listing as it is now, so a queue that
waited an hour does not push hour-old numbers.

**Coalescing.** At most one pending job per (seller, channel, kind, listing).
The enqueue is `insert … on conflict do update set available_at = now()`
on a partial unique index over pending rows, so ten edits in a minute are one
write. A claimed job may sit beside one newer pending job for the same key.
The claimed row already has its numbers. When that claim finishes back to
pending (retry or needs sign-in) and the pending twin is there, this row is
recorded `skipped` / `superseded` so the newer edit is the one that runs.

### Where jobs come from

`listing_sync::apply_event` (the existing listing outbox) gains a channel
step, guarded like the CardTrader one by `payload.steps.tcgplayer` so an
outbox retry does not enqueue twice. It maps the event's `mutation` to job
kinds with a pure function (`jobs_for_event`), then inserts them. A seller
with no live device gets no rows. A seller whose device is switched off gets
one `skipped` / `device_not_enabled` row per (listing, kind), counted in
`skip_count`, so the status card can say "14 changes skipped while sync was
off" without a row per edit.

Eligibility (v1): Pokémon singles (`game = pokemon`, not
sealed, not graded). The claim sends the card identity (card id, name, set,
collector number, condition, language, reverse/first edition) and, for a
linked listing, its `externalId`. Resolving the TCGplayer product id from
`tcgplayer_product_links` (TCGCSV database, see TCGCSV_PRICES.md) at claim
time is a follow-up; until then the box finds the SKU by set + number +
condition in the Portal and stores it as `externalId` on `done`.

### Skip reasons

A skipped job is terminal and recorded (`status = skipped`,
`skip_reason`). Only policy is a skip; waiting on the box is not.

| Reason | When |
| --- | --- |
| `device_not_enabled` | the switch is off at enqueue, or is turned off while jobs are pending (the disable action skips them) |
| `no_device` | no live device (grant revoked) |
| `not_eligible` | listing is not a linkable TCGplayer single |
| `listing_missing` | the listing row is gone at claim |
| `superseded` | enable replaced an open per-listing job, or this claim returned to pending while a newer pending twin existed |

Pending but not skipped: box offline, `signedIn=false`, rate-limited. They
run when the box is back. Turning the switch back on records a done
`full_resync` and queues one `set_qty` per eligible listing, so nothing
skipped while it was off is lost. A `set_qty` with no link is sent as
`push_listing`.

### Claim, lease, complete

- `claim` takes up to `max` (≤ 20) due jobs, `for update skip locked`, sets
  `status = claimed`, increments `attempts`, stores the handed-out kind in
  `claimed_kind`, a fresh `lease_token` (uuid) and `lease_until = now() + 300 s`.
  The box asks for at most 5 per pass so a batch finishes inside that lease.
  `full_resync` is never claimed.
- `complete` must carry the job id and its lease token. A token that is not
  the current one (expired and re-claimed by another run) is refused with
  `409 lease_lost`, so a stalled box cannot overwrite a newer result.
- Outcomes from the box. `attempts` here is the value claim stored:
  - `done` (with `externalId` for a push → upsert `channel_listing_links`).
    A job handed out as `push_listing` and completed without `externalId` is
    `400 channel_sync/external-id`; the job stays claimed;
  - `retry` (timeout, Portal error page) → back to pending, backoff
    `30 s × 4^min(attempts, 6)`, like the seller-webhook deliveries, unless
    `attempts >= 8`, then `dead`;
  - `failed` (permanent: SKU not found, Portal rejected the value) → `failed`
    with `last_error`, no retry;
  - `needs_sign_in` → back to pending and `attempts = greatest(attempts - 1, 0)`,
    so signing out does not spend the attempt.
- An expired lease is claimed again, and that reclaim increments `attempts`.
- After 8 attempts (`MAX_ATTEMPTS`, same as the listing outbox) a retry is
  `dead` and shows on the seller's status card.

## Orders

The box reads the Portal's order list and posts it with `action: orders`.
`channel_orders` is keyed by (channel, seller, external order id); posting
the same order again updates its status and changes nothing else.

Stock: each order line that matches a `channel_listing_links` row lowers that
Pokoin listing's quantity **once**, and only when the order has a `placedAt`
at or after that link's `created_at`. An older order is stored and the line
is `skippedBeforeLink`. An order with no `placedAt` is stored and the line is
`skippedNoDate`. Neither writes `channel_order_stock_applied`. The guard for
an applied line is `channel_order_stock_applied (channel, external_order_id,
line_key)`, written in the same transaction as the listing update, which also
enqueues the listing's `listing.changed` outbox event. So the other channels
(Pokoin shop, CardTrader `increment -n`) see the sale the same way they see a
Pokoin sale.

That transaction sets `pokoin.listing_change_source = 'channel:tcgplayer'`
(`set local`). Migration 128 adds one branch to the listing audit trigger
(`marketplace_user_listings_audit`, last defined in 092): a decrease under
that setting is recorded as `channel_synced`, not `sold`, the same way a
CardTrader mirror decrease is `cardtrader_synced`. A TCGplayer sale happened
at a TCGplayer price; counting it as a Pokoin sale at `price_pkn` would put
false evidence into Pokoin's sold stats and weights.
Lines that match nothing are kept on the order as `unmatched` for the seller
to review. A status that contains `cancel` or `refund` (any case) does not
change Pokoin stock; those lines are counted as `skippedCancelled`. If stock
was already applied and the order is cancelled later, Pokoin does not put the
quantity back; the seller adjusts the listing by hand.

Orders view: `GET /api/channel-orders` returns TCGplayer orders in the shape
of a Pokoin sale row (`channel`, `orderId`, `status`, `placedAt`, `lines`,
`totalCents`, `currency`). The seller orders page merges it with native
orders, sorted by date, with a channel chip like SortSwift's. That page
change is a follow-up.

Buyer data: only what fulfilment needs (name, ship-to address, shipping
method) is stored, on the nezopt writer, readable only by that seller. The
Seller Agreement requires this.

## Per-channel prices

Pokoin has one price per listing (`price_pkn`). The CardTrader push sends it
at the PKN peg (`PKN_USDT_PRICE = 0.005`, 200 PKN = 1.00) with no
adjustment, and later Pokoin price edits are not pushed to linked CardTrader
products (only quantity, via `increment`).

`channel_price_rules (seller_uid, channel)` adds a per-channel rule on top of
the base:

```text
channel_cents = round_mode( base_pkn × 0.005 × 100 × (1 + percent_bp / 10000) + fixed_cents )
```

with `round_mode` one of `cent` (nearest), `up_cent`, `charm_99` (up to the
next x.99). Example from SortSwift's panel: base 370.18; TCGplayer `+365 bp`
gives 383.69. No rule = base price (SortSwift's eight identical channels).
TCGplayer prices are USD; PKN is pegged to USDT, so no FX step.

## Box CLI

```text
tcgplayer-sync-box --api https://api.pokoin.com --token-file ~/.config/pokoin-tcgplayer-box/token \
                   --profile-dir ~/.local/share/pokoin-tcgplayer-box/profile \
                   --portal browser [--chrome /usr/bin/google-chrome] [--headless] \
                   [--max-writes N] [--portal-config ~/.config/pokoin-tcgplayer-box/portal.json]
tcgplayer-sync-box sign-in --profile-dir ~/.local/share/pokoin-tcgplayer-box/profile
tcgplayer-sync-box check --profile-dir ~/.local/share/pokoin-tcgplayer-box/profile \
                   [--sku SKU] [--portal-config ~/.config/pokoin-tcgplayer-box/portal.json]
```

- `fake`: the in-memory Portal the tests use.
- `csv` (not built): writes a TCGplayer-format inventory CSV for the seller to
  upload, and imports an order-export CSV the seller saves into a folder. No
  automation of TCGplayer pages.
- `browser`: Chrome over the DevTools protocol, using the profile above.
  Headful unless `--headless`. Between Portal pages it waits a random
  300–1200 ms. The runner still waits 2–6 s between jobs and stops at 600
  writes an hour. A write that already matches the page types nothing.
- `--max-writes N`: after N Portal writes that changed a page in this
  process, the in-flight job is completed and the box exits 0 without
  claiming more. The 600-an-hour cap still applies. Unchanged pages do not
  count.
- `sign-in`: opens the login page headful and waits until the signed-in
  marker appears. The seller types. The box only watches, then exits.
- `check`: reads only. It reports signed-in / blocked and which selectors it
  could and could not find on home, one search, and the order list. It stops
  at the first challenge or login page and does not open the pages after
  that. `check --sku <id>` also opens that SKU page and reports the quantity
  input, price input, save button, and their current values. It does not
  claim jobs, type, or click save. This is how the seller calibrates the config.
- `--portal-config`: a JSON file that replaces the unverified defaults. The
  starting point is `docs/tcgplayer-portal-config.example.json`.

Chrome is chosen with `--chrome`, then `CHROME` or `POKOIN_CHROME`, then
`google-chrome`, `google-chrome-stable`, `chromium`, or `chromium-browser`
on `PATH`.

## When the portal is blocked

A challenge is an iframe whose src contains `recaptcha`, `hcaptcha`,
`turnstile`, `captcha`, or `challenges.cloudflare`, a captcha selector from
the config, or a title like "Just a moment", "Attention Required", or
"Access denied".

A navigation the box built to an origin outside `allowedOrigins` is a
permanent failure. Landing there because the page redirected (SSO or a
security check) is `Blocked` with `redirected to <origin>`, so the job is
not burned and the box pauses for the seller.

On `Blocked` the current job completes `needs_sign_in` (the attempt is
refunded, same as a sign-in page). The rest of that batch is completed
`needs_sign_in` too. The next heartbeat sends `running=false` and
`error="blocked: <reason> — open the box's Chrome window and clear it"`.
Later passes claim nothing until `signed_in()` succeeds.

## Debug port

Chrome is started with `--remote-debugging-address=127.0.0.1` and a port
chosen by the OS. The worker refuses a DevTools websocket whose host is not
`127.0.0.1`. The port is loopback-only, so nothing off the machine can
attach. Any other process on the box still can. The box is the seller's own
computer; do not run it on a shared machine. The worker kills Chrome when
the process exits, and starts it again on the next pass if it has died.

## First live run

1. `tcgplayer-sync-box sign-in --profile-dir …` and sign in by hand in that
   Chrome window. Leave the window open.
2. `tcgplayer-sync-box check --profile-dir …` and read which selectors were
   missing on home, one search, and the order list.
3. Copy `docs/tcgplayer-portal-config.example.json`, fix the paths and
   selectors, and pass it with `--portal-config`. Run `check` again.
4. Enable sync. Enabling queues every eligible Pokémon single; there is no
   per-listing opt-out yet (see Known gaps). Then run
   `--portal browser --max-writes 5` with the token, profile, and portal
   config. Check those five SKUs on TCGplayer and in Pokoin, then run the
   same command without `--max-writes`.
5. Watch the Chrome window on that run. If a challenge appears, clear it
   in the window. The box will not.

## Known gaps

- Shared SKU quantities are not summed. TCGplayer keeps one quantity per SKU
  per seller. Two Pokoin listings mapped to the same SKU overwrite each
  other's absolute quantity. `complete` still stores both links and, when
  another listing of that seller already has the id, returns `sharedSku:
  true`. Keep one Pokoin listing per TCGplayer SKU until quantities are summed.
- Stock is not restored when an already-applied order is cancelled later. The
  seller adjusts that listing by hand.
- Seller Portal selectors are unverified until the seller runs `check` and
  calibrates `--portal-config`.
- There is no per-listing opt-out. Enabling sync queues every eligible
  Pokémon single. Use `--max-writes` for a small first run.

## Code

- Migrations: `scripts/sql/127_channel_sync.sql` (tables),
  `scripts/sql/128_channel_synced_audit.sql` (audit trigger branch). Not
  applied yet; apply on the nezopt writer.
- Server: `pokoin-rust/crates/commerce/src/channel_sync.rs`,
  `pokoin-rust/crates/commerce/src/handlers/channel_sync.rs`
- Box: `pokoin-rust/apps/tcgplayer-sync-box` (`src/browser/` is the Chrome portal)
- Portal config example: `docs/tcgplayer-portal-config.example.json`
