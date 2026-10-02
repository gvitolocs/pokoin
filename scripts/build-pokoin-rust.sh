#!/usr/bin/env bash
# Build one immutable pokoin-api binary for this machine.
# aarch64 builds need a cross linker; this script records the host target.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1090
source "$HOME/.cargo/env"
cd "$root/pokoin-rust"
target="$(rustc -vV | awk '/^host:/ { print $2 }')"
sha="$(git -C "$root" rev-parse --short=12 HEAD)"
cargo test -p pokoin-cache --offline || cargo test -p pokoin-cache
cargo build --release -p pokoin-api
out="$root/pokoin-rust/target/release/pokoin-api"
dest="$root/pokoin-rust/dist/pokoin-api-${sha}-${target}"
mkdir -p "$root/pokoin-rust/dist"
cp -a "$out" "$dest"
echo "$dest"
