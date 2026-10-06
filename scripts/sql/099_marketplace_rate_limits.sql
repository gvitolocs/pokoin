-- 099: Durable fixed-window rate-limit buckets for security-sensitive routes.
--
-- Backs limitSecurityCritical() in server/pokoin-api/_rate_limit.js: the same
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

-- Fully-expired windows are removed by purgeExpiredSecurityRateLimits()
-- (server/pokoin-api/_rate_limit.js) once a route is wired to this class.
