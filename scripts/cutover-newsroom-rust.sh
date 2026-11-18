#!/usr/bin/env bash
# Operator-run only. This script is not an install/deploy command.
set -euo pipefail
umask 077
if [[ ${1:-} != --execute || $# != 1 ]]; then
  echo 'Usage: cutover-newsroom-rust.sh --execute' >&2
  echo 'Requires a parity-complete, installed native newsroom; otherwise refuses before stopping Node.' >&2
  exit 2
fi
binary=${NEWSROOM_RUST_BINARY:-"$HOME/services/pokoin-newsroom/rust/pokoin-newsroom"}
data=${NEWSROOM_DATA_DIR:-"$HOME/services/pokoin-newsroom/data"}
env_file=${NEWSROOM_ENV_FILE:-"$HOME/.config/pokoin/newsroom.env"}
backup_root=${NEWSROOM_BACKUP_DIR:-"$HOME/services/pokoin-newsroom/rollbacks"}
old=pokoin-newsroom.service
new=pokoin-newsroom-rust.service
[[ -x "$binary" && -d "$data" && -f "$env_file" ]] || { echo 'Missing binary, data directory or env file.' >&2; exit 1; }
# All gates run before any service action. Current implementation deliberately
# exits nonzero on --activate: do not remove the gate to force a partial port.
"$binary" preflight --activate --data-dir "$data" --env-file "$env_file" >/dev/null
systemctl --user is-active --quiet "$old" || { echo 'Node newsroom must be active before cutover.' >&2; exit 1; }
if systemctl --user is-active --quiet "$new"; then echo 'Rust newsroom is already active.' >&2; exit 1; fi
mkdir -p "$backup_root"
exec 9>"$backup_root/cutover.lock"
flock -n 9 || { echo 'Another newsroom cutover is in progress.' >&2; exit 1; }
rollback_needed=0
rollback() {
  local code=$?
  trap - EXIT INT TERM
  if (( rollback_needed )); then
    echo 'Rust health failed; stopping Rust and restoring the Node service.' >&2
    # Never start Node if Rust could still own a publishing cycle.
    if ! systemctl --user stop "$new" || systemctl --user is-active --quiet "$new"; then
      echo 'CRITICAL: Rust stop could not be confirmed; Node remains stopped to prevent two publishers.' >&2
      exit 1
    fi
    # Crucial: retain CURRENT shared state. Restoring the backup would forget
    # articles Rust committed before failing, permitting duplicate publication.
    if ! systemctl --user start "$old" || ! systemctl --user is-active --quiet "$old"; then
      echo 'CRITICAL: Node rollback did not become active; inspect user journal.' >&2
      exit 1
    fi
  fi
  exit "$code"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
rollback_needed=1
systemctl --user stop "$old"
if systemctl --user is-active --quiet "$old"; then echo 'Node stop could not be confirmed.' >&2; exit 1; fi
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$backup_root/$stamp-$$"
"$binary" snapshot --data-dir "$data" --output "$backup" >/dev/null
# No migration/reset of attempts, updates, records, revisions, lessons or media:
# both implementations own exactly the same files, at different times.
systemctl --user start "$new"
healthy=0
for _ in {1..30}; do
  if systemctl --user is-active --quiet "$new" && "$binary" ready --data-dir "$data" --env-file "$env_file" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
(( healthy )) || { echo 'Native newsroom failed readiness.' >&2; exit 1; }
rollback_needed=0
printf 'Cutover healthy. Node is stopped; shared state retained. Backup: %s\n' "$backup"
# Intentionally do not enable/disable either unit; inspect the first complete
# publish/moderation cycles before selecting the boot owner in the runbook.
