#!/usr/bin/env bash
# Builds pokoin-ops on nezopt for every host that runs it:
#   dist/pokoin-ops/x86_64/pokoin-ops   nezopt and Oracle (built on Debian bookworm, glibc 2.36,
#                                       so it loads on Oracle's Ubuntu 22.04 glibc 2.35)
#   dist/pokoin-ops/aarch64/pokoin-ops  the Pi (user-local cross toolchain, as build-pokoin-rust-release.sh)
# Runs the tests first. Output goes to $POKOIN_OPS_DIST (default ~/pokoin-deploy/pokoin-ops).
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
src="$here/tools/pokoin-ops"
dist="${POKOIN_OPS_DIST:-$HOME/pokoin-deploy/pokoin-ops}"
target="${POKOIN_OPS_TARGET:-$HOME/pokoin-deploy/target-ops}"
source "$HOME/.cargo/env" 2>/dev/null || true

( cd "$src" && CARGO_TARGET_DIR="$target" cargo test --release )

mkdir -p "$dist/x86_64" "$dist/aarch64" "$target/bookworm" "$HOME/.cache/pokoin-ops-cargo"
docker run --rm --network host -u "$(id -u):$(id -g)" \
  -e CARGO_HOME=/cargo -e CARGO_TARGET_DIR=/target \
  -v "$src:/src:ro" -v "$target/bookworm:/target" -v "$HOME/.cache/pokoin-ops-cargo:/cargo" \
  -w /src rust:1.99-bookworm cargo build --release --locked
install -m 755 "$target/bookworm/release/pokoin-ops" "$dist/x86_64/pokoin-ops"

cross_env="${POKOIN_AARCH64_CROSS_ENV:-$HOME/.local/share/aarch64-cross/env.sh}"
# shellcheck disable=SC1090
[[ -f "$cross_env" ]] && source "$cross_env"
( cd "$src" && CARGO_TARGET_DIR="$target" cargo build --release --locked --target aarch64-unknown-linux-gnu )
install -m 755 "$target/aarch64-unknown-linux-gnu/release/pokoin-ops" "$dist/aarch64/pokoin-ops"

file "$dist/aarch64/pokoin-ops" | grep -q 'ARM aarch64' || { echo "aarch64 artifact is not aarch64" >&2; exit 1; }
newest_glibc() { objdump -T "$1" | grep -oE 'GLIBC_[0-9.]+' | sort -V | tail -1; }
echo "x86_64  $(newest_glibc "$dist/x86_64/pokoin-ops")  $(sha256sum "$dist/x86_64/pokoin-ops")"
echo "aarch64 $(newest_glibc "$dist/aarch64/pokoin-ops")  $(sha256sum "$dist/aarch64/pokoin-ops")"
