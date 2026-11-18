#!/usr/bin/env bash
# Refuse to start a heavy build when the filesystem is nearly full.
#
#   scripts/require-free-space.sh [min-GB] [path]
#
# Exits 1 when <path> (default: $HOME) has fewer than <min-GB> GB free
# (default: $POKOIN_MIN_FREE_GB, else 60). nezopt's / also holds the
# production Postgres writer and k3s: below ~25 GB free kubelet reports
# DiskPressure and evicts the overflow pods, and one pokoin-rust workspace
# debug build writes up to ~26 GB. Set POKOIN_MIN_FREE_GB=0 to bypass.
set -euo pipefail

min_gb="${1:-${POKOIN_MIN_FREE_GB:-60}}"
path="${2:-$HOME}"
[[ "$min_gb" =~ ^[0-9]+$ ]] || { echo "require-free-space: min-GB must be an integer, got '$min_gb'" >&2; exit 2; }
(( min_gb == 0 )) && exit 0

avail_kb="$(df -Pk -- "$path" | awk 'NR==2 { print $4 }')"
avail_gb=$(( avail_kb / 1024 / 1024 ))
if (( avail_gb < min_gb )); then
  mount="$(df -P -- "$path" | awk 'NR==2 { print $6 }')"
  cat >&2 <<EOF
require-free-space: only ${avail_gb} GB free on ${mount} (need ${min_gb} GB). Not starting the build.
  Free space first: delete your own finished worktrees' target/ dirs, or point
  CARGO_TARGET_DIR at a shared target (docs/RUST_RUNTIME.md "Deploy").
  Bypass for a small build: POKOIN_MIN_FREE_GB=0
EOF
  exit 1
fi
