-- 099: Durable fixed-window rate-limit buckets for security-sensitive routes.
--
-- Backs limit_security_critical() in pokoin-rust/crates/api-common/src/limits.rs: the same
-- fail-closed Postgres window pattern as scan_rate_limits, for brute-force,
-- payment, and paid-external-API paths that must never rely on the fail-open
-- Redis limiter. Buckets are rl:{scope}:{sha256(identity)[0:32]} so raw IPs
-- or tokens never land in the database.
-- Apply on the nezopt writer:
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace \
--     -d pokoin_marketplace -v ON_ERROR_STOP=1 < scripts/sql/099_marketplace_rate_limits.sql

create table if not exists public.marketplace_rate_limits (
  bucket text not null,
  window_start bigint not null,
  hits bigint not null default 1,
  primary key (bucket, window_start)
);

-- Fully-expired windows are removed by the limiter itself: about 1 in 200
-- limit_security_critical calls deletes every window before the last three.
