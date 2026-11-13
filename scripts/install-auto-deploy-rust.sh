#!/usr/bin/env bash
# Install (or remove) the Rust auto-deploy for the current user (docs/AUTO_DEPLOY.md). Never enables the timer: it
# prints that line for the owner.
#
# usage: scripts/install-auto-deploy-rust.sh [--no-pause] | --uninstall
#   default      copy the script to ~/.local/bin/pokoin-auto-deploy-rust, clone the planning repo if missing, copy the
#                units to ~/.config/systemd/user/, daemon-reload, and create the pause file so a fresh install is paused
#   --no-pause   install without creating the pause file (the timer then deploys as soon as it is enabled)
#   --uninstall  disable the timer, remove the units and the installed script, daemon-reload. Keeps the planning clone,
#                the state dir and the pause file
# env: POKOIN_AUTODEPLOY_DIR (state dir, default ~/scratch/pokoin-auto-deploy), POKOIN_AUTODEPLOY_CLONE_URL.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
bin=$HOME/.local/bin/pokoin-auto-deploy-rust
units=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
repo=$HOME/pokoin-deploy/auto-deploy-repo
st=${POKOIN_AUTODEPLOY_DIR:-$HOME/scratch/pokoin-auto-deploy}
url=${POKOIN_AUTODEPLOY_CLONE_URL:-https://github.com/gvitolocs/pokoin.git}
names=(pokoin-rust-auto-deploy.service pokoin-rust-auto-deploy.timer)

mode=install pause=1
for a in "$@"; do
  case $a in
    --uninstall) mode=uninstall ;;
    --no-pause) pause=0 ;;
    *) echo "usage: $0 [--no-pause] | --uninstall" >&2; exit 2 ;;
  esac
done

if [[ $mode == uninstall ]]; then
  systemctl --user disable --now pokoin-rust-auto-deploy.timer 2> /dev/null || true
  for n in "${names[@]}"; do rm -f "$units/$n"; done
  rm -f "$bin"
  systemctl --user daemon-reload
  echo "removed the units and $bin; kept $repo, $st and its pause file"
  exit 0
fi

# a fresh install is paused: the pause file is created unless --no-pause
if [[ $pause == 1 && ! -e "$st/pause" ]]; then
  mkdir -p "$st"
  echo "installed $(date -u +%FT%TZ): paused until the owner removes this file" > "$st/pause"
fi

mkdir -p "$(dirname "$bin")" "$units" "$(dirname "$repo")"
install -m 0755 "$here/scripts/auto-deploy-rust.sh" "$bin"
if [[ ! -d "$repo/.git" ]]; then git clone -q "$url" "$repo"; fi
for n in "${names[@]}"; do install -m 0644 "$here/deploy/systemd/$n" "$units/$n"; done
systemctl --user daemon-reload

echo "installed $bin and $units/{${names[0]},${names[1]}}"
if [[ -e "$st/pause" ]]; then echo "PAUSED: remove $st/pause to let it deploy"; fi
echo "to enable (not run):"
echo "  systemctl --user enable --now pokoin-rust-auto-deploy.timer"
