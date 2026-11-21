#!/usr/bin/env bash
# Installs failure mail + dead-man pings for the Oracle CardTrader market refresh, run
# from nezopt. A host change that needs Giuseppe's OK first (docs/BACKUPS_AND_ALERTS.md).
#
#   scripts/backup/install-ops-oracle.sh
set -euo pipefail
HOST="${POKOIN_ORACLE_HOST:-pokoin-marketplace}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
ops="$repo/deploy/ops/oracle"
bin="${POKOIN_OPS_DIST:-$HOME/pokoin-deploy/pokoin-ops}/x86_64/pokoin-ops"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST")
die() { echo "install-ops-oracle: $*" >&2; exit 1; }

# Files go to a private directory (mktemp -d, mode 0700) under the ssh user's home, removed when the script ends.
# The sha256 of every staged file is computed here and passed to the privileged step, which compares it and
# installs only from the staged copy. The staged binary is never executed.
stage=""
digests=()
stage_close() { [[ -z "$stage" ]] || "${SSH[@]}" "rm -rf -- $stage" >/dev/null 2>&1 || true; }
stage_open() {
  local dir
  # shellcheck disable=SC2016  # the remote shell expands $HOME
  dir="$("${SSH[@]}" 'mktemp -d "$HOME/.pokoin-stage.XXXXXXXX"')" || die "cannot create a staging directory on $HOST"
  [[ "$dir" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "unexpected staging path from $HOST"
  stage="$dir"
  trap stage_close EXIT
}
stage_put() { # <local file> <name in the staging directory>
  scp -q -o BatchMode=yes "$1" "$HOST:$stage/$2"
  digests+=("$2=$(sha256sum "$1" | cut -d' ' -f1)")
}
# run_remote: stdin is the step's script; it runs as root (sudo -n) after install-ops-lib.sh, with the
# staging directory and the digests as arguments.
run_remote() { { cat "$repo/scripts/backup/install-ops-lib.sh"; cat; } | "${SSH[@]}" "sudo -n -H bash -s -- $stage ${digests[*]}"; }

[[ -x "$bin" ]] || die "build first: scripts/backup/build-pokoin-ops.sh"
"${SSH[@]}" systemctl cat pokoin-cardtrader-daily-market-refresh.service >/dev/null || die "unit not found on $HOST"
stage_open
stage_put "$bin" pokoin-ops
stage_put "$ops/pokoin-notify@.service" pokoin-notify@.service
stage_put "$ops/pokoin-cardtrader-daily-market-refresh.service.d-alerts.conf" ct-alerts.conf
# The root step copies each staged file into its own root-owned directory (mktemp -d, mode 0700, under root's
# home, removed on exit) and verifies the copies; the ssh user's staging directory is only the transport.
# First step: check the mail keys in the host's alert configuration files before anything is installed.
run_remote <<'REMOTE' || die "install refused (see above); nothing was installed"
set -euo pipefail
stage="$1"; shift
work="$(mktemp -d "$HOME/.pokoin-root.XXXXXXXX")"
trap 'rm -rf -- "$work"' EXIT
copy_verified "$stage" "$work" "$@"
mail_keys_check
REMOTE
if ! "${SSH[@]}" sudo -n test -f /etc/pokoin/alerts.env; then
  key="$(grep -E '^(POKOIN_UPTIME_RESEND_API_KEY|RESEND_API_KEY)=' "$HOME/.config/pokoin/uptime-mail.env" | head -1 | cut -d= -f2- | tr -d "\"'")"
  [[ -n "$key" ]] || die "no Resend key in ~/.config/pokoin/uptime-mail.env"
  hc="$(grep -E '^POKOIN_HC_PING_KEY=' "$HOME/.config/pokoin/alerts.env" 2>/dev/null | cut -d= -f2- || true)"
  # The two mail keys are written as comments, so they define nothing and cannot shadow a later file: the owner
  # removes the # and fills them in (the install check refuses until then).
  printf 'RESEND_API_KEY=%s\nPOKOIN_HC_PING_KEY=%s\nPOKOIN_HC_SLUG_PREFIX=oracle-\n# Required: the only place the alert recipient comes from. Without it pokoin-ops refuses to send mail.\n# POKOIN_ALERT_MAIL_TO=\n# Required: the sender shown on alert mail (a verified sender for the mail provider).\n# POKOIN_ALERT_MAIL_FROM=\n' "$key" "$hc" \
    | "${SSH[@]}" 'sudo -n install -d -m 755 /etc/pokoin && sudo -n sh -c "umask 077; cat > /etc/pokoin/alerts.env"'
fi
run_remote <<'REMOTE' || die "install refused (see above); nothing was installed"
set -euo pipefail
stage="$1"; shift
work="$(mktemp -d "$HOME/.pokoin-root.XXXXXXXX")"
trap 'rm -rf -- "$work"' EXIT
copy_verified "$stage" "$work" "$@"
install -o root -g root -m 755 "$work/pokoin-ops" /usr/local/bin/pokoin-ops
install -m 644 "$work/pokoin-notify@.service" /etc/systemd/system/pokoin-notify@.service
install -D -m 644 "$work/ct-alerts.conf" /etc/systemd/system/pokoin-cardtrader-daily-market-refresh.service.d/alerts.conf
systemctl daemon-reload
REMOTE
"${SSH[@]}" /usr/local/bin/pokoin-ops --version
"${SSH[@]}" 'systemctl show pokoin-cardtrader-daily-market-refresh.service -p OnFailure -p ExecStartPre --no-pager | cut -c1-160'
