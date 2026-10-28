#!/usr/bin/env bash
# Pi → nezopt notices, so the nezopt overflow follows the Pi by events instead of polling
# (docs/NEZOPT_OVERFLOW.md, "Staying in sync with the Pi"). Run on nezopt, after
# `scripts/backup/install-ops-nezopt.sh pi-follow`. It changes the Pi: owner's OK first.
#
#   scripts/install-pi-overflow-notify.sh install    # Pi user, key, units; nezopt authorized_keys line; self-test
#   scripts/install-pi-overflow-notify.sh test       # one `release` and one `video` notice from the Pi
#   scripts/install-pi-overflow-notify.sh remove     # Pi units off and removed; the nezopt key line removed
#
# On the Pi: system user pokoin-notify (no shell; traverse-only ACL on /srv/pokoin/card-images),
# key /etc/pokoin/overflow-notify/id_ed25519,
# pokoin-overflow-notify.path (+ .service) on /srv/pokoin/rust/ and poko-video-notify.service
# (inotifywait on poko-video/). The key only runs nezopt's forced command pokoin-pi-hook, from
# the Pi's address. Nothing touches pokoin-rust-api.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
PI="${PI_HOST:-pi-home}"
PI_ADDR="${PI_ADDR:-192.168.178.46}"
NEZOPT_ADDR="${NEZOPT_ADDR:-192.168.178.55}"
HOOK="$HOME/.local/bin/pokoin-pi-hook"
AUTH="$HOME/.ssh/authorized_keys"
TAG=pokoin-pi-notify
die() { echo "install-pi-overflow-notify: $*" >&2; exit 1; }
say() { echo "== $*"; }

install_pi() {
  [[ -x "$HOOK" ]] || die "install the nezopt side first: scripts/backup/install-ops-nezopt.sh pi-follow"
  local tmp; tmp="$(ssh "$PI" mktemp -d)"
  scp -q "$repo/deploy/pi/pokoin-overflow-notify" "$repo/deploy/pi/poko-video-notify" \
    "$repo/deploy/pi/pokoin-overflow-notify.path" "$repo/deploy/pi/pokoin-overflow-notify.service" \
    "$repo/deploy/pi/poko-video-notify.service" "$PI:$tmp/"
  # nezopt's own host key, not a keyscan: the Pi pins what nezopt says it is.
  awk -v a="$NEZOPT_ADDR" '{print a, $1, $2}' /etc/ssh/ssh_host_ed25519_key.pub | ssh "$PI" "cat > $tmp/known_hosts"
  ssh "$PI" "set -e
    command -v inotifywait >/dev/null || { echo 'inotify-tools missing' >&2; exit 1; }
    id pokoin-notify >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin pokoin-notify
    install -d -m 0750 -o root -g pokoin-notify /etc/pokoin/overflow-notify
    [ -f /etc/pokoin/overflow-notify/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -C $TAG -f /etc/pokoin/overflow-notify/id_ed25519
    chown root:pokoin-notify /etc/pokoin/overflow-notify/id_ed25519 /etc/pokoin/overflow-notify/id_ed25519.pub
    chmod 0640 /etc/pokoin/overflow-notify/id_ed25519
    install -m 0644 -o root -g pokoin-notify $tmp/known_hosts /etc/pokoin/overflow-notify/known_hosts
    install -D -m 0755 $tmp/pokoin-overflow-notify /usr/local/lib/pokoin/pokoin-overflow-notify
    install -D -m 0755 $tmp/poko-video-notify /usr/local/lib/pokoin/poko-video-notify
    install -m 0644 $tmp/pokoin-overflow-notify.path $tmp/pokoin-overflow-notify.service $tmp/poko-video-notify.service /etc/systemd/system/
    # card-images is nes:nes 0750; traverse only (no group nes: that group reads the API env file).
    command -v setfacl >/dev/null || { echo 'acl (setfacl) missing' >&2; exit 1; }
    setfacl -m u:pokoin-notify:x /srv/pokoin/card-images
    rm -rf $tmp"
  local pub; pub="$(ssh "$PI" cat /etc/pokoin/overflow-notify/id_ed25519.pub)"
  [[ "$pub" == ssh-ed25519\ * ]] || die "no Pi public key"
  local line="restrict,from=\"$PI_ADDR\",command=\"$HOOK\" $pub"
  if ! grep -qF "${pub#* }" "$AUTH" 2>/dev/null; then
    grep -v " $TAG\$" "$AUTH" > "$AUTH.new" 2>/dev/null || true
    echo "$line" >> "$AUTH.new"
    chmod 600 "$AUTH.new" && mv "$AUTH.new" "$AUTH"
    say "nezopt authorized_keys: added the $TAG key (forced command $HOOK, from $PI_ADDR)"
  fi
  ssh "$PI" "systemctl daemon-reload && systemctl enable --now pokoin-overflow-notify.path poko-video-notify.service"
  test_notice
}

test_notice() {
  local verb
  for verb in release video; do
    ssh "$PI" "runuser -u pokoin-notify -- /usr/local/lib/pokoin/pokoin-overflow-notify $verb" | grep -qx "ok $verb" \
      || die "$verb notice did not reach nezopt"
    say "$verb notice ok"
  done
  ssh "$PI" "systemctl is-active pokoin-overflow-notify.path poko-video-notify.service"
}

remove_pi() {
  ssh "$PI" "systemctl disable --now pokoin-overflow-notify.path poko-video-notify.service 2>/dev/null || true
    setfacl -x u:pokoin-notify /srv/pokoin/card-images 2>/dev/null || true
    rm -f /etc/systemd/system/pokoin-overflow-notify.path /etc/systemd/system/pokoin-overflow-notify.service /etc/systemd/system/poko-video-notify.service
    systemctl daemon-reload"
  if [[ -f "$AUTH" ]]; then
    grep -v " $TAG\$" "$AUTH" > "$AUTH.new" || true
    chmod 600 "$AUTH.new" && mv "$AUTH.new" "$AUTH"
  fi
  say "removed; run scripts/backup/install-ops-nezopt.sh pi-follow again to put the 5-minute timers back"
  rm -f "$HOME/.config/systemd/user/pokoin-overflow-sync.timer.d/50-backstop.conf" "$HOME/.config/systemd/user/poko-video-mirror.timer.d/50-backstop.conf"
  systemctl --user daemon-reload
  systemctl --user restart pokoin-overflow-sync.timer poko-video-mirror.timer
}

case "${1:-}" in
  install) install_pi ;;
  test) test_notice ;;
  remove) remove_pi ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
