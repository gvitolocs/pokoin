#!/usr/bin/env bash
# Rehearse the marketplace writer's major upgrade (17 -> 19) on a copy of its
# data, while the live writer keeps serving. Nothing here stops, changes or
# writes to the live container; it only reads it with pg_basebackup.
#
#   scripts/postgres-major-upgrade.sh rehearse 19beta4            # copy mode, keeps the 17 copy
#   MODE=link scripts/postgres-major-upgrade.sh rehearse 19.1     # link mode, as fast as the cutover
#   scripts/postgres-major-upgrade.sh clean <work-dir>
#
# Steps: base backup of the live writer -> recover that copy with the writer's
# own 17 image and shut it down cleanly -> build infra/postgres-upgrade ->
# pg_upgrade --check, then pg_upgrade -> start 19 on the result (no network)
# -> extension updates, statistics, and a row-count comparison against the
# 17 copy. The 17 copy (copy mode) and the 19 result stay in the work dir, so
# bench/postgres/run.py can compare them on real data.
# The real cutover is a separate, explicit step: docs/POSTGRES_VERSION.md.
set -euo pipefail

WRITER=${WRITER:-pokoin-marketplace-postgres-15t}
SUPERUSER=${SUPERUSER:-pokoin_marketplace}
DB=${DB:-pokoin_marketplace}
ROOT=${POKOIN_PG_UPGRADE_ROOT:-/home/nez/data/pg-upgrade-rehearsal}
MODE=${MODE:-copy}
JOBS=${JOBS:-4}
HERE=$(cd "$(dirname "$0")/.." && pwd)
say() { echo "== $*"; }
die() { echo "postgres-major-upgrade: $*" >&2; exit 1; }

action=${1:-}
case $action in
  rehearse) new=${2:?target version, e.g. 19beta4 or 19.1} ;;
  clean)
    dir=${2:?work dir}
    [[ $dir == "$ROOT"/* ]] || die "refusing to delete $dir: not under $ROOT"
    docker rm -f pg-rehearsal-old pg-rehearsal-new >/dev/null 2>&1 || true
    rm -rf -- "$dir"
    exit 0 ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac

old_image=$(docker inspect -f '{{.Config.Image}}' "$WRITER")
[[ $old_image =~ ^postgres:[0-9]+\.[0-9]+-alpine ]] \
  || die "$WRITER runs $old_image; pin an exact postgres:<major>.<minor>-alpine image first (scripts/postgres-recreate.py)"
old_version=${old_image#postgres:}; old_version=${old_version%%-*}
# Both images must be built on the Alpine release the writer runs (musl, ICU).
alpine=$(docker exec "$WRITER" cat /etc/alpine-release | cut -d. -f1,2)
old_image=postgres:${old_version}-alpine${alpine}
new_image=postgres:${new}-alpine${alpine}
docker pull -q "$old_image" >/dev/null
docker pull -q "$new_image" >/dev/null
uid_gid=$(docker inspect -f '{{.Config.User}}' "$WRITER"); uid_gid=${uid_gid:-1000:1000}
socket_dir=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/run/postgresql"}}{{.Source}}{{end}}{{end}}' "$WRITER")
[[ -n $socket_dir ]] || die "$WRITER does not mount /var/run/postgresql from the host"

work=$ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$old_version-to-$new
mkdir -p "$work"/{old,new,work}
chown -R "$uid_gid" "$work"
say "work dir $work ($old_image -> $new_image, mode $MODE)"

q() { docker exec "$WRITER" psql -U "$SUPERUSER" -d postgres -XAtc "$1"; }
read -r encoding provider locale < <(q "select pg_encoding_to_char(encoding), case datlocprovider when 'i' then 'icu' when 'b' then 'builtin' else 'libc' end, coalesce(nullif(datlocale, ''), datcollate) from pg_database where datname = 'template0'" | tr '|' ' ')
say "template0: $encoding $provider $locale; databases: $(q "select string_agg(datname, ' ' order by datname) from pg_database where not datistemplate")"
say "size: $(q "select pg_size_pretty(sum(pg_database_size(oid))) from pg_database"), free in $ROOT: $(df -h --output=avail "$ROOT" | tail -1)"

say "base backup of the live writer (read-only for the writer)"
env_file=$(mktemp); trap 'rm -f "$env_file"' EXIT
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$WRITER" | sed -n 's/^POSTGRES_PASSWORD=/PGPASSWORD=/p' >"$env_file"
started=$SECONDS
docker run --rm --user "$uid_gid" --network none --env-file "$env_file" \
  -v "$socket_dir":/var/run/postgresql -v "$work/old":/backup "$old_image" \
  pg_basebackup -h /var/run/postgresql -U "$SUPERUSER" -D /backup/data -X stream -c fast
say "base backup took $((SECONDS - started))s"

say "recover the copy with $old_image and shut it down cleanly"
docker rm -f pg-rehearsal-old >/dev/null 2>&1 || true
docker run -d --name pg-rehearsal-old --user "$uid_gid" --network none \
  -v "$work/old/data":/var/lib/postgresql/data "$old_image" \
  postgres -c listen_addresses='' -c shared_buffers=1GB -c max_connections=120 >/dev/null
for _ in $(seq 1 600); do
  docker exec pg-rehearsal-old pg_isready -q 2>/dev/null && break
  sleep 1
done
docker exec pg-rehearsal-old pg_isready -q || die "the 17 copy did not become ready (docker logs pg-rehearsal-old)"
counts_sql="select string_agg(relname || '=' || n, ' ' order by relname) from (select c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by pg_relation_size(c.oid) desc, c.relname limit 12) t"
docker exec pg-rehearsal-old psql -U "$SUPERUSER" -d "$DB" -XAtc "$counts_sql" >"$work/work/counts-old.txt"
docker exec pg-rehearsal-old pg_ctl -D /var/lib/postgresql/data stop -m fast >/dev/null
docker rm pg-rehearsal-old >/dev/null

say "build the upgrade image ($old_version -> $new)"
docker build -q -t "pokoin-pg-upgrade:$old_version-to-$new" \
  --build-arg OLD="$old_version" --build-arg NEW="$new" --build-arg ALPINE="$alpine" \
  --build-arg PGUID="${uid_gid%%:*}" --build-arg PGGID="${uid_gid##*:}" \
  "$HERE/infra/postgres-upgrade" >/dev/null
new_pgdata=$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$new_image" 2>/dev/null | sed -n 's/^PGDATA=//p')
[[ -n $new_pgdata ]] || die "cannot read PGDATA from $new_image"
upgrade() {
  docker run --rm --network none \
    -v "$work/old/data":/old -v "$work/new":/var/lib/postgresql -v "$work/work":/work \
    -e PGDATA="$new_pgdata" -e SUPERUSER="$SUPERUSER" -e ENCODING="$encoding" -e PROVIDER="$provider" \
    -e LOCALE="$locale" -e MODE="$MODE" -e JOBS="$JOBS" \
    "pokoin-pg-upgrade:$old_version-to-$new" "$1"
}
say "pg_upgrade --check"
upgrade check
say "pg_upgrade --$MODE"
started=$SECONDS
upgrade upgrade
say "upgrade step took $((SECONDS - started))s"

say "start $new_image on the result (no network) and finish"
docker rm -f pg-rehearsal-new >/dev/null 2>&1 || true
docker run -d --name pg-rehearsal-new --user "$uid_gid" --network none \
  -v "$work/new":/var/lib/postgresql -v "$work/work":/work "$new_image" \
  postgres -c listen_addresses='' -c shared_buffers=1GB -c max_connections=120 >/dev/null
for _ in $(seq 1 120); do
  docker exec pg-rehearsal-new pg_isready -q 2>/dev/null && break
  sleep 1
done
if [[ -s $work/work/update_extensions.sql ]]; then
  docker exec pg-rehearsal-new psql -U "$SUPERUSER" -d postgres -Xq -f /work/update_extensions.sql
fi
docker exec pg-rehearsal-new vacuumdb -U "$SUPERUSER" --all --analyze-in-stages --missing-stats-only >/dev/null
docker exec pg-rehearsal-new psql -U "$SUPERUSER" -d "$DB" -XAtc "$counts_sql" >"$work/work/counts-new.txt"
if diff -u "$work/work/counts-old.txt" "$work/work/counts-new.txt"; then
  say "row counts of the 12 largest tables match: $(cat "$work/work/counts-new.txt")"
else
  die "row counts differ between the 17 copy and the 19 result (diff above)"
fi
docker exec pg-rehearsal-new psql -U "$SUPERUSER" -d "$DB" -XAtc "select version()"
say "rehearsal done. 19 is running as pg-rehearsal-new (no network); logs and diffs in $work/work."
say "clean up: scripts/postgres-major-upgrade.sh clean $work"
