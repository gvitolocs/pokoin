#!/usr/bin/env bash
# Install the Docker log cap on the Pi and check it hourly (logrotate.timer).
#
#   scripts/deploy-pi-logrotate.sh [commit]
set -euo pipefail

die() { echo "deploy-pi-logrotate: $*" >&2; exit 1; }
say() { echo "== $*"; }

REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
PI="${PI_HOST:-pi-home}"

git -C "$REPO" fetch -q origin || die "git fetch origin failed"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "commit is not on origin/main; merge it first"

git -C "$REPO" show "$COMMIT:scripts/pokoin-docker-logrotate.conf" \
  | ssh "$PI" "cat > /tmp/pokoin-docker.logrotate"
ssh "$PI" 'set -e
logrotate -d /tmp/pokoin-docker.logrotate >/dev/null 2>&1 || { echo "logrotate config check failed" >&2; exit 1; }
install -o root -g root -m 0644 /tmp/pokoin-docker.logrotate /etc/logrotate.d/pokoin-docker
rm -f /tmp/pokoin-docker.logrotate
mkdir -p /etc/systemd/system/logrotate.timer.d
cat > /etc/systemd/system/logrotate.timer.d/hourly.conf <<CONF
[Timer]
OnCalendar=
OnCalendar=hourly
AccuracySec=5m
CONF
systemctl daemon-reload
systemctl restart logrotate.timer
systemctl start logrotate.service
for f in /srv/pokoin/docker/containers/*/*-json.log; do printf "%s %sMB\n" "$(basename "$(dirname "$f")" | cut -c1-12)" "$(( $(stat -c %s "$f") / 1048576 ))"; done
systemctl list-timers logrotate.timer --no-pager --no-legend | head -1'
say "Docker log cap live @ ${COMMIT:0:12}"
