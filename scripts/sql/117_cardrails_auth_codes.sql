-- 117: Card Rails one-time sign-in codes.
--
-- "Sign in with Pokoin" for the Card Rails apps (com.pokoin.cardrails): the
-- consent page /connect/cardrails mints a one-time code via
-- POST /api/cardrails-authorize and redirects it to
-- cardrails://auth/pokoin; the Card Rails API exchanges it (plus the PKCE
-- S256 verifier) on POST /api/cardrails-token. Raw codes are never stored —
-- only their SHA-256 hashes, with a 120 second expiry and single redemption
-- (the token route deletes the row it returns). Rows whose token step never
-- arrives are swept by the next authorize once they are an hour stale.
-- Shared by every API instance (Pi + nezopt overflow): apply on the nezopt
-- writer, from where it replicates to the Pi read replica:
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace \
--     -d pokoin_marketplace -v ON_ERROR_STOP=1 < scripts/sql/117_cardrails_auth_codes.sql

create table if not exists public.cardrails_auth_codes (
  code_hash      text primary key,
  firebase_uid   text not null,
  email          text not null,
  email_verified boolean not null default false,
  code_challenge text not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null
);

create index if not exists cardrails_auth_codes_expires_idx
  on public.cardrails_auth_codes (expires_at);
