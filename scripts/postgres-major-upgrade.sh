#!/usr/bin/env bash
# Rehearse the marketplace writer's major upgrade (17 -> 19) on a copy of its
# data, while the live writer keeps serving. Nothing here stops, changes or
# writes to the live container; it only reads it with pg_basebackup.
#
#   scripts/postgres-major-upgrade.sh rehearse 19.0               # copy mode, keeps the 17 copy
#   MODE=link scripts/postgres-major-upgrade.sh rehearse 19.1     # link mode, as fast as the cutover
#   scripts/postgres-major-upgrade.sh clean <work-dir>
#
# The writer's minor comes from its image tag, and from `postgres --version` when the
# container was created from a floating tag and only holds an image id. copy mode
# refuses to start below 2.2x the cluster size free in the work root, link mode below
# 1.2x; POKOIN_PG_UPGRADE_SKIP_SPACE_CHECK=1 runs it anyway.
#
# Steps: base backup of the live writer -> recover that copy with the writer's
# own 17 image, read its ssl and row counts, shut it down cleanly -> build
# infra/postgres-upgrade -> pg_upgrade --check, then pg_upgrade, with TLS off
# for its private starts, and the settings' absolute paths that live inside the
# old data directory carried into the new one relative -> start 19 on the result
# (no network) -> ssl and template0 compared against the 17 copy, the defaults 19
# changed printed, extension updates, statistics and a row-count comparison. The
# 17 copy (copy mode) and the 19 result stay in the work dir, so
# bench/postgres/run.py can compare them on real data.
# The real cutover is a separate, explicit step: docs/POSTGRES_VERSION.md.
set -Eeuo pipefail

WRITER=${WRITER:-pokoin-marketplace-postgres-15t}
SUPERUSER=${SUPERUSER:-pokoin_marketplace}
DB=${DB:-pokoin_marketplace}
ROOT=${POKOIN_PG_UPGRADE_ROOT:-/home/nez/data/pg-upgrade-rehearsal}
MODE=${MODE:-copy}
JOBS=${JOBS:-4}
HERE=$(cd "$(dirname "$0")/.." && pwd)
say() { echo "== $*"; }
die() { echo "postgres-major-upgrade: $*" >&2; exit 1; }
# No step may end the run without a word: say where it stopped.
trap 'echo "postgres-major-upgrade: failed at line $LINENO: $BASH_COMMAND" >&2' ERR

action=${1:-}
case $action in
  rehearse) new=${2:?target version, e.g. 19.0 or 19.1} ;;
  clean)
    dir=${2:?work dir}
    [[ $dir == "$ROOT"/* ]] || die "refusing to delete $dir: not under $ROOT"
    docker rm -f pg-rehearsal-old pg-rehearsal-new >/dev/null 2>&1 || true
    rm -rf -- "$dir"
    exit 0 ;;
  *) sed -n '2,24p' "$0"; exit 2 ;;
esac

old_image=$(docker inspect -f '{{.Config.Image}}' "$WRITER")
# Both images must be built on the Alpine release the writer runs (musl, ICU).
alpine=$(docker exec "$WRITER" cat /etc/alpine-release | cut -d. -f1,2)
if [[ $old_image =~ ^postgres:([0-9]+\.[0-9]+)-alpine ]]; then
  old_version=${BASH_REMATCH[1]}
  say "old version from the container's image tag: $old_image"
else
  # A container created from a floating tag keeps an image id in its config, not a name,
  # so the tag cannot say which minor runs. The server binary can.
  old_version=$(docker exec "$WRITER" postgres --version |
    sed -n 's/^postgres (PostgreSQL) \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')
  [[ $old_version =~ ^[0-9]+\.[0-9]+$ ]] \
    || die "$WRITER: its config says $old_image and \`postgres --version\` says nothing usable; neither gives postgres:<major>.<minor>-alpine (scripts/postgres-recreate.py pins one)"
  say "old version from the server binary (\`docker exec $WRITER postgres --version\`): $old_version"
fi
old_image=postgres:${old_version}-alpine${alpine}
new_image=postgres:${new}-alpine${alpine}
docker pull -q "$old_image" >/dev/null
docker pull -q "$new_image" >/dev/null
uid_gid=$(docker inspect -f '{{.Config.User}}' "$WRITER"); uid_gid=${uid_gid:-1000:1000}
socket_dir=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/run/postgresql"}}{{.Source}}{{end}}{{end}}' "$WRITER")
[[ -n $socket_dir ]] || die "$WRITER does not mount /var/run/postgresql from the host"
# The path the writer's own server sees its data directory as, which is what
# an absolute path in its settings was written against. upgrade-cluster.sh
# turns such paths into relative ones; the default is the mount the official
# image and this deployment both use.
old_pgdata_in=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$WRITER" | sed -n 's/^PGDATA=//p')
old_pgdata_in=${old_pgdata_in:-/var/lib/postgresql/data}

work=$ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$old_version-to-$new
mkdir -p "$work"/{old,new,work}
chown -R "$uid_gid" "$work"
say "work dir $work ($old_image -> $new_image, mode $MODE)"

q() { docker exec "$WRITER" psql -U "$SUPERUSER" -d postgres -XAtc "$1"; }
pretty() { q "select pg_size_pretty(${1}::bigint)"; }
# One query, any of the three servers this run talks to, so the writer, its 17
# copy and the 19 result are described the same way and can be compared.
dbinfo() { docker exec "$1" psql -U "$SUPERUSER" -d postgres -XAtc "select pg_encoding_to_char(encoding), case datlocprovider when 'i' then 'icu' when 'b' then 'builtin' else 'libc' end, coalesce(nullif(datlocale, ''), datcollate) from pg_database where datname = 'template0'" | tr '|' ' '; }
read -r encoding provider locale < <(dbinfo "$WRITER")
# read succeeds even when the command behind <(...) died, so check its product.
[[ -n $encoding ]] || die "no template0 encoding from $WRITER: the psql read above returned nothing"
say "template0: $encoding $provider $locale; databases: $(q "select string_agg(datname, ' ' order by datname) from pg_database where not datistemplate")"
say "size: $(q "select pg_size_pretty(sum(pg_database_size(oid))) from pg_database"), free in $ROOT: $(df -h --output=avail "$ROOT" | tail -1)"
say "the writer sees its own data directory as $old_pgdata_in: a settings path under it is carried into the new cluster relative, one outside it is left for a mount"

size_bytes=$(q "select coalesce(sum(pg_database_size(oid)), 0) from pg_database")
free_bytes=$(df -B1 --output=avail "$ROOT" | tail -1 | tr -d '[:space:]')
need_times=22   # copy mode keeps the base backup and a second cluster, plus room for WAL
[[ $MODE == link ]] && need_times=12
need_bytes=$(( size_bytes * need_times / 10 ))
if [[ ${POKOIN_PG_UPGRADE_SKIP_SPACE_CHECK:-} != 1 ]] && (( free_bytes < need_bytes )); then
  die "$ROOT has $(pretty "$free_bytes") free and $MODE mode needs $(pretty "$need_bytes") (the $(pretty "$size_bytes") cluster times $need_times over 10): make room, or set POKOIN_PG_UPGRADE_SKIP_SPACE_CHECK=1 to run anyway"
fi
say "space: $(pretty "$free_bytes") free in $ROOT, $(pretty "$need_bytes") needed for $MODE mode"

say "base backup of the live writer (read-only for the writer)"
env_file=$(mktemp "${TMPDIR:-/tmp}/pg-upgrade-env.XXXXXX"); trap 'rm -f "$env_file"' EXIT
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
# These containers run as --user "$uid_gid", a uid with no passwd entry in the stock
# image, so every client must be given its user: pg_isready without -U reports
# "no attempt" and exits 3 even on a server that is accepting connections.
for _ in $(seq 1 600); do
  docker exec pg-rehearsal-old pg_isready -q -U "$SUPERUSER" 2>/dev/null && break
  sleep 1
done
docker exec pg-rehearsal-old pg_isready -q -U "$SUPERUSER" || die "the 17 copy did not become ready (docker logs pg-rehearsal-old)"
counts_sql="select string_agg(relname || '=' || n, ' ' order by relname) from (select c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by pg_relation_size(c.oid) desc, c.relname limit 12) t"
docker exec pg-rehearsal-old psql -U "$SUPERUSER" -d "$DB" -XAtc "$counts_sql" >"$work/work/counts-old.txt"
# Read while it is still up: the 19 result must come up with the same TLS
# setting, and the writer's own is only knowable from the copy that carries it.
old_ssl=$(docker exec pg-rehearsal-old psql -U "$SUPERUSER" -d "$DB" -XAtc "show ssl")
# The server is PID 1 of this container, so stopping the server stops the
# container under any attached docker exec: stop the container itself instead.
# Its stop signal is SIGINT, which PostgreSQL treats as a fast shutdown.
docker stop --time 300 pg-rehearsal-old >/dev/null
# Prove the shutdown was clean, reading the same pg_controldata field that
# infra/postgres-upgrade/upgrade-cluster.sh:48-52 refuses anything else on.
old_state=$(docker run --rm --user "$uid_gid" --network none \
  -v "$work/old/data":/var/lib/postgresql/data "$old_image" \
  pg_controldata /var/lib/postgresql/data | sed -n 's/^Database cluster state: *//p')
[[ $old_state == "shut down" ]] \
  || die "the 17 copy is '$old_state' after the stop, not 'shut down' (docker logs pg-rehearsal-old)"
say "17 copy shut down cleanly"
docker rm pg-rehearsal-old >/dev/null

say "build the upgrade image ($old_version -> $new)"
docker build -q -t "pokoin-pg-upgrade:$old_version-to-$new" \
  --build-arg OLD="$old_version" --build-arg NEW="$new" --build-arg ALPINE="$alpine" \
  --build-arg PGUID="${uid_gid%%:*}" --build-arg PGGID="${uid_gid##*:}" \
  "$HERE/infra/postgres-upgrade" >/dev/null
new_pgdata=$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$new_image" | sed -n 's/^PGDATA=//p')
[[ -n $new_pgdata ]] || die "cannot read PGDATA from $new_image"
upgrade() {
  docker run --rm --network none \
    -v "$work/old/data":/old -v "$work/new":/var/lib/postgresql -v "$work/work":/work \
    -e PGDATA="$new_pgdata" -e SUPERUSER="$SUPERUSER" -e ENCODING="$encoding" -e PROVIDER="$provider" \
    -e LOCALE="$locale" -e MODE="$MODE" -e JOBS="$JOBS" \
    -e OLD_PGDATA_IN_CONTAINER="$old_pgdata_in" \
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
  docker exec pg-rehearsal-new pg_isready -q -U "$SUPERUSER" 2>/dev/null && break
  sleep 1
done
docker exec pg-rehearsal-new pg_isready -q -U "$SUPERUSER" || die "the 19 result did not become ready (docker logs pg-rehearsal-new)"
# The point of this run is a server that comes up the way the writer does, so
# the two settings a wrong carry-over would change are compared here, not
# looked for later: TLS, and the collation initdb could not validate on musl.
new_ssl=$(docker exec pg-rehearsal-new psql -U "$SUPERUSER" -d "$DB" -XAtc "show ssl")
[[ $new_ssl == "$old_ssl" ]] \
  || die "the 19 result runs with ssl='$new_ssl' but the 17 copy ran with ssl='$old_ssl': the TLS settings or their files did not carry over"
say "ssl: $old_ssl (17) -> $new_ssl (19)"
new_template0=$(dbinfo pg-rehearsal-new)
[[ $new_template0 == "$encoding $provider $locale" ]] \
  || die "template0 on the 19 result is '$new_template0', on the writer '$encoding $provider $locale': the new cluster's collation is not the live one"
say "template0: $encoding $provider $locale (17) -> $new_template0 (19)"
# What the cutover has to set by hand because 19 changed it under us; naming
# them here is the only way this run records the values the new server chose.
defaults=$(docker exec pg-rehearsal-new psql -U "$SUPERUSER" -d postgres -XAtc \
  "select name || '=' || setting from pg_settings where name in ('data_checksums', 'io_method', 'jit') order by name")
[[ $(wc -l <<<"$defaults") == 3 ]] \
  || die "the 19 result answered '$(tr '\n' ' ' <<<"$defaults")' for data_checksums, io_method and jit: one of those settings is not there, and the cutover names all three"
say "19 as it came up: $(tr '\n' ' ' <<<"$defaults")"
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
