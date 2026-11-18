#!/bin/sh
# archive_command of the Pi hot standby (archive_mode = always). Runs inside the Alpine
# replica container (BusyBox sh), so it only copies %p into the spool next to PGDATA;
# pokoin-wal-push.timer on the Pi host uploads the spool with wal-g and empties it.
#
#   archive_command = 'sh /var/lib/postgresql/data/wal-spool-bin/walspool-archive.sh %p %f'
#
# Invoked through sh so a lost exec bit cannot break archiving: exit 126 (not executable)
# is fatal to the archiver and does not even count in pg_stat_archiver.failed_count.
#
# Exit 0 only once the copy is durable. A non-zero exit makes Postgres keep the segment
# in pg_wal and retry, which is what we want when the spool is full (uploads stalled).
set -eu
src="$1"
name="$2"
spool="${POKOIN_WAL_SPOOL:-/var/lib/postgresql/data/wal-spool}"
max_kb="${POKOIN_WAL_SPOOL_MAX_KB:-20971520}" # 20 GiB, on /srv/pokoin

case "$name" in
  */* | .* | "") echo "walspool: refusing file name '$name'" >&2; exit 1 ;;
esac
dest="$spool/$name"
if [ -f "$dest" ]; then
  # Re-archived after a restart: fine if identical, never overwrite a different file.
  if cmp -s "$src" "$dest"; then exit 0; fi
  echo "walspool: $name is already spooled with different content" >&2
  exit 1
fi
used_kb=$(du -sk "$spool" | cut -f1)
if [ "$used_kb" -ge "$max_kb" ]; then
  echo "walspool: spool holds ${used_kb} KB (cap ${max_kb} KB); uploads are stalled" >&2
  exit 1
fi
tmp="$spool/.$name.part"
rm -f "$tmp"
cp "$src" "$tmp"
sync "$tmp"
mv "$tmp" "$dest"
sync "$spool"
