#!/usr/bin/env bash
# Apply the CardTrader connected-seller/native-sale dedupe from an exact
# origin/main commit to the nezopt writer, then verify its Pi replica.
set -euo pipefail

die() { echo "deploy-cardtrader-sale-dedupe: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
PRIMARY_CONTAINER="${PRIMARY_CONTAINER:-pokoin-marketplace-postgres-15t}"
REPLICA_CONTAINER="${REPLICA_CONTAINER:-pokoin-marketplace-postgres-replica}"
DB_USER="${DB_USER:-pokoin_marketplace}"
DB_NAME="${DB_NAME:-pokoin_marketplace}"
API_CONTAINER="${API_CONTAINER:-pokoin-oracle-api}"
STAGE="$(mktemp -d /tmp/pokoin-ct-sale-dedupe-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

primary_psql() {
  docker exec -i "$PRIMARY_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"
}

replica_sql() {
  # Values are trusted constants or repository-owned SQL expanded locally.
  # shellcheck disable=SC2029
  ssh pi-home "docker exec -i '$REPLICA_CONTAINER' psql -U '$DB_USER' -d '$DB_NAME' -At -v ON_ERROR_STOP=1 -c \"$1\""
}

writer_url_parts() {
  # Container name is a trusted local deployment parameter expanded locally.
  # shellcheck disable=SC2029
  ssh pi-home "tr '\0' '\n' < /proc/\$(docker inspect -f '{{.State.Pid}}' '$API_CONTAINER')/environ" \
    | sed -nE 's#^MARKETPLACE_WRITER_DATABASE_URL=[a-z]+://([^:@/]+)[^@]*@([^/?]+)/([^?]*).*#\1 \2 \3#p' \
    | head -1
}

DUPLICATE_COUNT_SQL="
  select count(*)
  from public.marketplace_user_listing_events event
  where event.event_type in ('sold', 'quantity_decreased')
    and (
      exists (
        select 1 from public.marketplace_user_listings listing
        where listing.id = event.listing_id
          and lower(coalesce(listing.source_listing_id, '')) like 'ct:%'
      )
      or exists (
        select 1 from public.marketplace_cardtrader_product_links link
        where link.listing_id = event.listing_id
      )
    )
"

STATS_MISMATCH_SQL="
  with actual as (
    select
      event.card_id,
      (timezone('utc', event.occurred_at))::date as event_day,
      count(*)::integer as sold_listings,
      coalesce(sum(
        case
          when coalesce(event.quantity_after, 0) < coalesce(event.quantity_before, 0)
            then event.quantity_before - event.quantity_after
          else greatest(coalesce(event.quantity_before, 0), 1)
        end
      ), 0)::integer as sold_quantity
    from public.marketplace_user_listing_events event
    where event.event_type in ('sold', 'quantity_decreased')
    group by event.card_id, (timezone('utc', event.occurred_at))::date
  ), keys as (
    select card_id, observed_day from public.marketplace_listing_stats_daily where source = 'native'
    union
    select card_id, event_day from actual
  )
  select count(*)
  from keys
  left join public.marketplace_listing_stats_daily stats
    on stats.card_id = keys.card_id
   and stats.observed_day = keys.observed_day
   and stats.source = 'native'
  left join actual
    on actual.card_id = keys.card_id
   and actual.event_day = keys.observed_day
  where coalesce(stats.sold_listings, 0) <> coalesce(actual.sold_listings, 0)
     or coalesce(stats.sold_quantity, 0) <> coalesce(actual.sold_quantity, 0)
"

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; integrate and push it first"
git -C "$REPO" show "$COMMIT:scripts/sql/092_cardtrader_sale_dedupe.sql" \
  > "$STAGE/092_cardtrader_sale_dedupe.sql"

read -r role host db <<<"$(writer_url_parts)"
[[ -n "${role:-}" ]] || die "could not read the API writer URL"
say "API writes as $role@$host/$db"
[[ "$host" == "192.168.178.55:25432" && "$db" == "$DB_NAME" ]] \
  || die "API writer is $host/$db, not the verified nezopt writer"
[[ "$(primary_psql -Atc 'select pg_is_in_recovery()')" == "f" ]] \
  || die "$PRIMARY_CONTAINER is read-only"

before="$(primary_psql -Atc "$DUPLICATE_COUNT_SQL")"
say "linked CardTrader events misclassified as native before migration: $before"
say "apply 092_cardtrader_sale_dedupe.sql from $COMMIT"
primary_psql -q < "$STAGE/092_cardtrader_sale_dedupe.sql"

[[ "$(primary_psql -Atc "$DUPLICATE_COUNT_SQL")" == "0" ]] \
  || die "writer still contains linked CardTrader native-sale events"
[[ "$(primary_psql -Atc "$STATS_MISMATCH_SQL")" == "0" ]] \
  || die "writer native sold counters do not match genuine native events"
primary_psql -Atc "select position('cardtrader_synced' in pg_get_functiondef('public.marketplace_user_listings_audit()'::regprocedure)) > 0" \
  | grep -qx t || die "writer trigger lacks CardTrader dedupe guard"

say "transactional trigger probe (rolled back)"
primary_psql -q <<'SQL'
begin;
do $$
declare
  chosen record;
  before_event_id bigint;
  emitted_event text;
  sold_before integer;
  sold_after integer;
begin
  select id, card_id, quantity_available
  into chosen
  from public.marketplace_user_listings
  where lower(coalesce(source_listing_id, '')) like 'ct:%'
    and status in ('active', 'paused')
    and quantity_available > 0
  order by updated_at desc
  limit 1
  for update;

  if chosen.id is null then
    raise exception 'No active linked CardTrader row is available for the trigger probe.';
  end if;

  select coalesce(max(id), 0) into before_event_id
  from public.marketplace_user_listing_events;

  select coalesce(sold_quantity, 0) into sold_before
  from public.marketplace_listing_stats_daily
  where card_id = chosen.card_id
    and observed_day = (timezone('utc', now()))::date
    and source = 'native';
  sold_before := coalesce(sold_before, 0);

  update public.marketplace_user_listings
  set
    quantity_available = quantity_available - 1,
    status = case when quantity_available - 1 <= 0 then 'sold_out' else status end,
    updated_at = now()
  where id = chosen.id;

  select event_type into emitted_event
  from public.marketplace_user_listing_events
  where id > before_event_id
    and listing_id = chosen.id
  order by id desc
  limit 1;

  select coalesce(sold_quantity, 0) into sold_after
  from public.marketplace_listing_stats_daily
  where card_id = chosen.card_id
    and observed_day = (timezone('utc', now()))::date
    and source = 'native';
  sold_after := coalesce(sold_after, 0);

  if emitted_event is distinct from 'cardtrader_synced' then
    raise exception 'Expected cardtrader_synced, got %', emitted_event;
  end if;
  if sold_after is distinct from sold_before then
    raise exception 'Native sold quantity changed from % to %', sold_before, sold_after;
  end if;
end;
$$;
rollback;
SQL

say "wait for Pi replica"
for _ in $(seq 1 30); do
  replica_guard="$(replica_sql "select position('cardtrader_synced' in pg_get_functiondef('public.marketplace_user_listings_audit()'::regprocedure)) > 0")"
  replica_duplicates="$(replica_sql "$DUPLICATE_COUNT_SQL")"
  if [[ "$replica_guard" == "t" && "$replica_duplicates" == "0" ]]; then
    say "writer and replica verified: duplicate native CardTrader sales = 0"
    exit 0
  fi
  sleep 2
done

die "Pi replica did not receive the trigger/history reconciliation within 60 seconds"
