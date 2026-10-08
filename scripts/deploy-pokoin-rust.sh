#!/usr/bin/env bash
# Deploy a clean, already-pushed main commit without changing the traffic manifest.
set -euo pipefail
die() { echo "deploy-pokoin-rust: $*" >&2; exit 1; }
REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")"
PI="${PI_HOST:-pi-home}"
BIN="$REPO/pokoin-rust/target/aarch64-unknown-linux-gnu/release/pokoin-api"
git -C "$REPO" fetch -q origin
[[ "$COMMIT" == "$(git -C "$REPO" rev-parse origin/main)" ]] || die "deploy only the exact origin/main commit"
[[ "$COMMIT" == "$(git -C "$REPO" rev-parse HEAD)" ]] || die "checkout must be on the requested commit"
git -C "$REPO" diff --quiet HEAD -- || die "tracked changes must be committed before deployment"
[[ -f "$BIN" ]] || die "build the clean aarch64 release first"
file "$BIN" | grep -q 'ARM aarch64' || die "artifact is not aarch64"
DIGEST="$(sha256sum "$BIN" | cut -d ' ' -f 1)"
REMOTE="/tmp/pokoin-rust-deploy-$COMMIT"
ssh "$PI" "mkdir -p '$REMOTE'"
scp -q "$BIN" "$PI:$REMOTE/pokoin-api"
scp -q "$REPO/scripts/install-pokoin-rust.py" "$PI:$REMOTE/install.py"
scp -q "$REPO/deploy/systemd/pokoin-rust-api.service" "$PI:$REMOTE/api.service"
ssh "$PI" "python3 '$REMOTE/install.py' --candidate '$REMOTE/pokoin-api' --commit '$COMMIT' --sha256 '$DIGEST' --unit '$REMOTE/api.service'"
ssh "$PI" "rm -rf '$REMOTE'"
