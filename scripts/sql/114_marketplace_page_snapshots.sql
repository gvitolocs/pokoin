-- Page snapshots: prebuilt public desk bodies served with one primary-key read
-- (`pokoin-rust/crates/catalog-api/src/shared/page_snapshot.rs`).
--
--   kind       key                          served by
--   set        set slug                     GET /api/marketplace-expansion-page?slug=…&productType=card
--   set-index  all                          GET /api/marketplace-expansion-page (no slug)
--   artist     artist slug                  GET /api/marketplace-artist-cards?…&tiles=1
--   version    pokoin_version_sets.version  GET /api/marketplace-version-set?cardId=
--   related    public card id               GET /api/marketplace-related?cardId=, and
--                                            `related` in GET /api/marketplace-card-page
--
-- `rows` holds one serialised JSON object per card, exactly what the live route
-- emits, so Postgres cuts a page window (`rows[a:b]`) and the API joins bytes.
-- A snapshot not confirmed by the builder (`checked_at`) within its kind's
-- freshness window is ignored and the route answers live.
--
-- Built by `pokoin-api job build-lists --kind=set|artist|version|related|related-delta`
-- (k3s CronJobs build-lists-* in infra/k3s/pokoin-overflow.yaml, run against
-- the nezopt writer; the Pi reads its streaming replica). The job also creates
-- this table itself; apply this file on the writer before deploying so the
-- table exists before the first build. Idempotent.
create table if not exists public.marketplace_page_snapshots (
  kind text not null,
  key text not null,
  head text not null,
  rows text[] not null,
  c1 bytea,
  version text not null,
  built_at timestamptz not null default now(),
  checked_at timestamptz not null default now(),
  primary key (kind, key)
);
