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
#   OLD_PGDATA_IN_CONTAINER   where the OLD server saw its own data directory
#              (default /var/lib/postgresql/data), so an absolute path in its
#              settings can be turned into a path inside the new one
#   MODE       copy (default) | clone | link | swap: how data files move
#   JOBS       parallel jobs (default 4)
set -eu
action=${1:-check}
OLD_BIN=/opt/pg-old/bin
NEW_BIN=$(dirname "$(command -v postgres)")
OLD_DATA=${OLD_DATA:-/old}
NEW_DATA=${PGDATA:?PGDATA}
SUPERUSER=${SUPERUSER:-pokoin_marketplace}
OLD_IN_CONTAINER=${OLD_PGDATA_IN_CONTAINER:-/var/lib/postgresql/data}
MODE=${MODE:-copy}
JOBS=${JOBS:-4}
: "${ENCODING:?ENCODING of the old template0, e.g. UTF8}" "${LOCALE:?LOCALE of the old template0, e.g. en_US.utf8}"
PROVIDER=${PROVIDER:-libc}

# pg_upgrade starts the old postmaster privately, from /old, and that server
# reads its own postgresql.auto.conf. The writer's turns TLS on with absolute
# certificate paths, which only exist where its data directory is mounted at
# $OLD_IN_CONTAINER, so the private start dies with "could not load server
# certificate file". TLS is not needed for it: pg_upgrade reaches it only over
# the socket it makes in /work. --old-options is pg_upgrade's name for options
# passed directly to the old postgres command; if the auto.conf value wins
# over a command-line -c after all, this step fails with that same certificate
# FATAL in /work/pg_upgrade_server.log and docs/POSTGRES_VERSION.md names the
# mount that makes the paths resolve instead.
OLD_OPTS="-c ssl=off"

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
"$NEW_BIN/pg_upgrade" -b "$OLD_BIN" -B "$NEW_BIN" -d "$OLD_DATA" -D "$NEW_DATA" -U "$SUPERUSER" \
  --old-options="$OLD_OPTS" --check
[ "$action" = check ] && exit 0

started=$(date +%s)
"$NEW_BIN/pg_upgrade" -b "$OLD_BIN" -B "$NEW_BIN" -d "$OLD_DATA" -D "$NEW_DATA" -U "$SUPERUSER" \
  --old-options="$OLD_OPTS" --"$MODE" --jobs "$JOBS"
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

# pg_upgrade moves data, not the files the configuration points at, and an
# absolute path in those settings is only valid where the OLD server saw its
# own data directory. Every absolute path inside it becomes a path relative to
# the new data directory instead, which is where PostgreSQL looks for a
# relative one: the new cluster starts with the old cluster's TLS material, the
# files travel with the data, and the cluster stays movable. Anything outside
# the data directory does not travel, so it is named for the operator instead.
# Only the new copy of the settings is written; the old directory stays exactly
# as the rollback expects it. No content of any of these files is ever printed.
carried=0 outside=0
for conf in "$NEW_DATA/postgresql.auto.conf" "$NEW_DATA/postgresql.conf"; do
  [ -f "$conf" ] || continue
  for name in ssl_cert_file ssl_key_file ssl_ca_file ssl_crl_file ssl_dh_params_file hba_file ident_file; do
    line=$(grep -E "^[[:space:]]*${name}[[:space:]]*=" "$conf" | tail -1)
    [ -n "$line" ] || continue
    val=$(printf '%s\n' "$line" | sed "s/^[^=]*=[[:space:]]*//; s/[[:space:]]*\$//")
    case $val in \'*\') val=${val#\'}; val=${val%\'} ;; \"*\") val=${val#\"}; val=${val%\"} ;; esac
    case $val in /*) ;; *) continue ;; esac
    case $val in
      "$OLD_IN_CONTAINER"/*)
        rel=${val#"$OLD_IN_CONTAINER"/}
        [ -f "$OLD_DATA/$rel" ] || { echo "$name points at $val, inside the old data directory, but the base backup holds no $rel" >&2; exit 1; }
        mkdir -p "$(dirname "$NEW_DATA/$rel")"
        cp -p "$OLD_DATA/$rel" "$NEW_DATA/$rel"
        # The server refuses to read a key that another user can see.
        [ "$name" = ssl_key_file ] && chmod 600 "$NEW_DATA/$rel"
        awk -v n="$name" -v v="$rel" -v q="'" '
          $0 ~ "^[[:space:]]*" n "[[:space:]]*=" { print n " = " q v q; next }
          { print }' "$conf" >"$conf.tmp" && mv "$conf.tmp" "$conf"
        carried=$((carried + 1))
        echo "carried $name: $rel copied into the new data directory, setting rewritten to the relative path"
        ;;
      *)
        outside=$((outside + 1))
        echo "left $name = $val: outside $OLD_IN_CONTAINER, so mount that file at the same path in the new container"
        ;;
    esac
  done
done
echo "absolute path settings in the carried configuration: $carried moved inside the data directory, $outside left for a mount"
ls /work/update_extensions.sql 2>/dev/null && echo "run /work/update_extensions.sql on the new server"
echo "done: start the new server, then vacuumdb --all --analyze-in-stages --missing-stats-only"
