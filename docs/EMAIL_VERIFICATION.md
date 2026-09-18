# Email/password registration verification

Email/password registration is a pending-until-verified state machine. Google
sign-in and wallet authentication (MetaMask custom-token flow) are **outside**
this machine and keep their existing semantics.

## State machine (email/password only)

```
NEW → PENDING_EMAIL_VERIFICATION → VERIFIED → ACTIVE
                    ↺ (expired/failed stays pending; link retry/resend)
```

- `NEW / PENDING_EMAIL_VERIFICATION`: `POST /api/register-email` stores a
  `pending_email_signups/{sha256(token)}` Firestore doc (password
  AES-256-GCM-encrypted via `SIGNUP_ENCRYPTION_SECRET`, 1 h expiry, username +
  redirectPath kept as pending data). No Firebase Auth identity exists yet, so
  a pending user cannot sign in or reach any authenticated surface.
- `VERIFIED / ACTIVE`: `POST /api/verify-email-signup` (`finalizeVerifiedUser`)
  creates the Firebase identity with `emailVerified: true`, stamps the
  `pok_email_verified` custom claim, claims the username (falls back to a
  unique handle on a clash), creates `balances/{uid}`, marks the pending doc
  `completed`, and returns a sign-in custom token.

Idempotency: the pending-doc `status` gate is the once-only transition.
Re-calling with the same token returns `400 {code: 'already_verified'}`;
any failure after user creation deletes the identity again so the same link
retries cleanly. Two tabs racing resolve at `createUser` — the loser gets
`409 {code: 'already_verified'}` and no duplicates.

## Resend

`POST /api/register-email` with `{resend: true, email}` re-issues a fresh
token (old link becomes `superseded`; the encrypted credentials carry over).
Rate limits live on the pending doc: 60 s cooldown, 10 sends per signup.
The web SPA probes this endpoint after `auth/invalid-credential`-class login
failures, so logging in before verifying lands on the "Check your email"
screen with resend.

## Web SPA surface

- `market/src/pages/Auth.jsx` renders the states: signup → Check-your-email
  (resend + cooldown) → `/auth?signupToken=…` callback → `signInWithCustomToken`
  → redirect into the app. `?verified=1` (native Firebase action-code return)
  shows "Email verified, sign in".
- Pure helpers + tests: `market/src/email-signup.js` / `email-signup.test.js`.

## Server-side enforcement

`api/_firebase.js` `verifyBearerToken` applies a provider-aware guard
(`POKOIN_REQUIRE_VERIFIED_PASSWORD === '1'` to enable): only tokens with
`sign_in_provider === 'password'` and neither `email_verified` nor
`pok_email_verified` are rejected (403 `auth/pokoin-email-not-verified`).
Google (`google.com`), wallet (`custom`), and unknown/missing providers are
never affected.

## Rollout (legacy users)

Legacy web email/password users were created client-side unverified. Before
enabling the flag:

1. Run the grandfathering backfill (dry-run default):
   `node scripts/backfill-password-email-verification.js` in
   `pokemon_card_vault` (needs `FIREBASE_*` admin env), then `--apply`.
2. Set `POKOIN_REQUIRE_VERIFIED_PASSWORD=1` on the API deployment.
   Password-identity tokens minted before the backfill need one refresh
   (max 1 h) to pick up the claim.

Directly-forged Firebase identities (public web API key, `createUser` REST)
have neither claim, so once the flag is on they are denied privileged API
access.

## Env vars

- `RESEND_API_KEY` — Resend sending (verification mail from
  `no-reply@pokoin.com`, overridable with `NO_REPLY_EMAIL_FROM`).
- `SIGNUP_ENCRYPTION_SECRET` — pending-signup password encryption (the
  manifest previously listed it as `PENDING_SIGNUP_SECRET`; the code reads
  `SIGNUP_ENCRYPTION_SECRET`).
- `PUBLIC_SITE_URL` — canonical origin for verification links
  (`https://pokoin.com`).
- `POKOIN_REQUIRE_VERIFIED_PASSWORD` — enables the bearer guard (off by
  default until the backfill ran).
- `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY`.

## Abandoned signups

Pending docs expire after 1 h and flip to `expired`/`superseded` on touch;
they are never active. Optional durable cleanup: a Firestore TTL policy on
`pending_email_signups.expiresAt` (no cron added — no existing cron pattern
for this in the project).

## Tests

- `pokemon_card_vault/api/register-email.test.js` — pending-only creation,
  validation, resend rate limits, link supersession, CORS/method contract.
- `pokemon_card_vault/api/verify-email-signup.test.js` — once-only
  finalization, retry harmlessness, invalid/expired tokens, username-clash
  fallback, auto username, DB-failure retry, concurrent-race resolution.
- `pokemon_card_vault/api/_firebase.test.js` — provider-aware guard predicate
  (password vs Google vs wallet vs unknown).
- `pokemon_card_vault/scripts/backfill-password-email-verification.js`
  exports `needsBackfillClaim` for reuse.
- `pokoin-web/market/src/email-signup.test.js` — token parsing, pending-login
  code classification, verify-error classification, cooldown math.
