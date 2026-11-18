#!/bin/sh
# Runs inside the pokoin-pg-upgrade image (Dockerfile next to this file):
# pg_upgrade from the OLD binaries in /opt/pg-old to the image's own.
#
#   upgrade-cluster.sh check     # initdb the new cluster if needed, pg_upgrade --check
#   upgrade-cluster.sh upgrade   # the same, then the real pg_upgrade
#
# Mounts and environment:
#   /old       the old PGDATA, cleanly shut down (not a running server)
#   $PGDATA    the new PGDATA (the image's default, e.g. /var/lib/postgresql/19/docker)
#   /work      pg_upgrade's working directory: logs, update_extensions.sql
#   SUPERUSER  the old cluster's bootstrap superuser (default pokoin_marketplace)
#   ENCODING, PROVIDER, LOCALE   template0's encoding, locale provider and
#              locale on the old cluster (the host script reads them)
#   MODE       copy (default) | clone | link | swap: how data files move
#   JOBS       parallel jobs (default 4)
set -eu
action=${1:-check}
OLD_BIN=/opt/pg-old/bin
NEW_BIN=$(dirname "$(command -v postgres)")
OLD_DATA=${OLD_DATA:-/old}
NEW_DATA=${PGDATA:?PGDATA}
SUPERUSER=${SUPERUSER:-pokoin_marketplace}
MODE=${MODE:-copy}
JOBS=${JOBS:-4}
: "${ENCODING:?ENCODING of the old template0, e.g. UTF8}" "${LOCALE:?LOCALE of the old template0, e.g. en_US.utf8}"
PROVIDER=${PROVIDER:-libc}

case $action in check|upgrade) ;; *) echo "usage: upgrade-cluster.sh check|upgrade" >&2; exit 2 ;; esac
case $MODE in copy|clone|link|swap) ;; *) echo "MODE must be copy, clone, link or swap" >&2; exit 2 ;; esac

state=$("$OLD_BIN/pg_controldata" "$OLD_DATA" | sed -n 's/^Database cluster state: *//p')
if [ "$state" != "shut down" ]; then
  echo "old cluster state is '$state'; it must be 'shut down' (stop it cleanly first)" >&2
  exit 1
fi
echo "old: $("$OLD_BIN/postgres" --version), new: $("$NEW_BIN/postgres" --version)"

# pg_upgrade needs the same data checksum setting on both sides; initdb turns
# checksums on by default since 18, the old writer was created without them.
if [ "$("$OLD_BIN/pg_controldata" "$OLD_DATA" | sed -n 's/^Data page checksum version: *//p')" = 0 ]; then
  checksums=--no-data-checksums
else
  checksums=--data-checksums
fi

if [ ! -s "$NEW_DATA/PG_VERSION" ]; then
  mkdir -p "$NEW_DATA"
  chmod 700 "$NEW_DATA"
  "$NEW_BIN/initdb" -D "$NEW_DATA" -U "$SUPERUSER" --encoding="$ENCODING" \
    --locale-provider="$PROVIDER" --locale="$LOCALE" $checksums --auth=trust >/work/initdb.log
  echo "initdb: new cluster created ($checksums, $ENCODING, $PROVIDER $LOCALE)"
fi

cd /work
"$NEW_BIN/pg_upgrade" -b "$OLD_BIN" -B "$NEW_BIN" -d "$OLD_DATA" -D "$NEW_DATA" -U "$SUPERUSER" --check
[ "$action" = check ] && exit 0

started=$(date +%s)
"$NEW_BIN/pg_upgrade" -b "$OLD_BIN" -B "$NEW_BIN" -d "$OLD_DATA" -D "$NEW_DATA" -U "$SUPERUSER" \
  --"$MODE" --jobs "$JOBS"
echo "pg_upgrade --$MODE took $(( $(date +%s) - started ))s"

# pg_upgrade moves data, not configuration. Carry over the files the old
# cluster was configured with; postgresql.conf is only diffed, because a 17
# file can name settings 19 no longer has.
for file in pg_hba.conf pg_ident.conf postgresql.auto.conf; do
  [ -f "$OLD_DATA/$file" ] && cp -p "$OLD_DATA/$file" "$NEW_DATA/$file" && echo "copied $file"
done
for file in "$OLD_DATA"/*.crt "$OLD_DATA"/*.key "$OLD_DATA"/*.pem; do
  [ -f "$file" ] && cp -p "$file" "$NEW_DATA/" && echo "copied $(basename "$file")"
done
settings() { grep -v -E '^[[:space:]]*(#|$)' "$1" | sed 's/[[:space:]]*#.*$//' | sort; }
settings "$OLD_DATA/postgresql.conf" >/work/old.conf.settings
settings "$NEW_DATA/postgresql.conf" >/work/new.conf.settings
if ! diff /work/old.conf.settings /work/new.conf.settings >/work/postgresql.conf.diff; then
  echo "postgresql.conf differs (old '<', new '>'): review /work/postgresql.conf.diff"
fi
ls /work/update_extensions.sql 2>/dev/null && echo "run /work/update_extensions.sql on the new server"
echo "done: start the new server, then vacuumdb --all --analyze-in-stages --missing-stats-only"
