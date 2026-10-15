#!/usr/bin/env bash
# Test and build one pokoin-api release on nezopt with shared cargo targets.
#
#   scripts/build-pokoin-rust-release.sh [<commit>]   # default: origin/main
#   scripts/build-pokoin-rust-release.sh --skip-tests [<commit>]
#
# Every release uses the same detached checkout ($POKOIN_DEPLOY_DIR/rust-release)
# and the same two target dirs, so a deploy recompiles only what changed instead
# of writing a fresh ~26 GB debug target per commit:
#   x86_64 test gate  $POKOIN_DEPLOY_DIR/target-x86      (cargo test --workspace)
#   aarch64 release   $POKOIN_DEPLOY_DIR/target-aarch64  (pokoin-api for the Pi)
# The binary is copied to rust-release/pokoin-rust/target/aarch64-unknown-linux-gnu/
# release/pokoin-api, where scripts/deploy-pokoin-rust.sh expects it. Then:
#   cd "$POKOIN_DEPLOY_DIR/rust-release" && scripts/deploy-pokoin-rust.sh
#
# Refuses to start under $POKOIN_MIN_FREE_GB (default 60) GB free. A shared
# target larger than $POKOIN_DEPLOY_TARGET_MAX_GB (default 40) is wiped first.
set -euo pipefail
die() { echo "build-pokoin-rust-release: $*" >&2; exit 1; }

skip_tests=0
if [[ "${1:-}" == "--skip-tests" ]]; then skip_tests=1; shift; fi
root="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)/.."
REPO="$(cd "$REPO" && pwd)"
DEPLOY="${POKOIN_DEPLOY_DIR:-$HOME/pokoin-deploy}"
SRC="$DEPLOY/rust-release"
X86="${POKOIN_DEPLOY_TARGET_X86:-$DEPLOY/target-x86}"
ARM="${POKOIN_DEPLOY_TARGET_AARCH64:-$DEPLOY/target-aarch64}"
MAX_GB="${POKOIN_DEPLOY_TARGET_MAX_GB:-40}"
ARCH=aarch64-unknown-linux-gnu

mkdir -p "$DEPLOY"
bash "$root/scripts/require-free-space.sh" "${POKOIN_MIN_FREE_GB:-60}" "$DEPLOY"

# One release build at a time: the targets and the checkout are shared.
exec 9>"$DEPLOY/.rust-release.lock"
flock -n 9 || { echo "build-pokoin-rust-release: waiting for another release build" >&2; flock 9; }

git -C "$REPO" fetch -q origin
COMMIT="$(git -C "$REPO" rev-parse "${1:-origin/main}^{commit}")"
git -C "$REPO" merge-base --is-ancestor "$COMMIT" origin/main \
  || die "${COMMIT:0:12} is not on origin/main"
SHORT="${COMMIT:0:12}"

if ! git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$REPO" worktree prune
  git -C "$REPO" worktree add -q --detach "$SRC" "$COMMIT"
fi
git -C "$SRC" checkout -q --detach --force "$COMMIT"
git -C "$SRC" clean -q -ffdx
[[ "$(git -C "$SRC" rev-parse HEAD)" == "$COMMIT" ]] || die "checkout is not at $SHORT"

cap_target() {
  local dir="$1" gb
  [[ -d "$dir" ]] || return 0
  gb=$(( $(du -xsk -- "$dir" | cut -f1) / 1024 / 1024 ))
  if (( gb > MAX_GB )); then
    echo "build-pokoin-rust-release: $dir is ${gb} GB (> ${MAX_GB}); wiping it" >&2
    rm -rf -- "$dir"
  fi
}
cap_target "$X86"
cap_target "$ARM"

# shellcheck disable=SC1091
source "$HOME/.cargo/env"
cd "$SRC/pokoin-rust"

if (( ! skip_tests )); then
  echo "build-pokoin-rust-release: cargo test --workspace $SHORT (target $X86)"
  # Incremental state is useless for a one-shot gate and doubles the target size.
  if ! CARGO_TARGET_DIR="$X86" CARGO_INCREMENTAL=0 nice -n 10 cargo test --workspace --locked \
    2>&1 | tee "$DEPLOY/rust-$SHORT-tests.log"; then
    die "tests failed; see $DEPLOY/rust-$SHORT-tests.log"
  fi
fi

bash "$root/scripts/require-free-space.sh" "${POKOIN_MIN_FREE_GB:-60}" "$DEPLOY"
echo "build-pokoin-rust-release: cargo build --release $ARCH $SHORT (target $ARM)"
POKOIN_BUILD_COMMIT="$COMMIT" POKOIN_BUILD_DIRTY=false CARGO_TARGET_DIR="$ARM" \
  nice -n 10 cargo build --release --locked --target "$ARCH" -p pokoin-api

out="$SRC/pokoin-rust/target/$ARCH/release"
mkdir -p "$out"
install -m 0755 "$ARM/$ARCH/release/pokoin-api" "$out/pokoin-api"
file "$out/pokoin-api" | grep -q 'ARM aarch64' || die "artifact is not aarch64"
echo "$out/pokoin-api"
echo "next: cd $SRC && scripts/deploy-pokoin-rust.sh"
