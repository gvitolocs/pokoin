#!/usr/bin/env bash
# Build and install the Rust CardTrader listing dump (nezopt) and bridge (Oracle).
#
#   scripts/deploy-cardtrader-dump.sh            # from a clean checkout of origin/main
#
# nezopt: /home/nez/pokoin-cardtrader/releases/<commit>/ + `current` symlink, which
#   scripts/run-all-cardtrader-daily.sh runs when present (else the Python dump).
# Oracle: /home/ubuntu/bin/pokoin-cardtrader-bridge (x86_64, needs glibc >= 2.34),
#   replaced atomically; a run already using the old binary keeps it until it exits.
set -euo pipefail
die() { echo "deploy-cardtrader-dump: $*" >&2; exit 1; }
REPO="$(git rev-parse --show-toplevel)"
COMMIT="$(git -C "$REPO" rev-parse HEAD)"
ORACLE="${ORACLE_HOST:-pokoin-marketplace}"
BASE="${POKOIN_CT_DUMP_HOME:-/home/nez/pokoin-cardtrader}"
git -C "$REPO" fetch -q origin
[[ "$COMMIT" == "$(git -C "$REPO" rev-parse origin/main)" ]] || die "deploy only the exact origin/main commit"
git -C "$REPO" diff --quiet HEAD -- || die "tracked changes must be committed before deployment"

TARGET="${CARGO_TARGET_DIR:-$REPO/pokoin-rust/target}"
( cd "$REPO/pokoin-rust" && cargo build --release --locked \
    -p cardtrader-listing-dump -p cardtrader-bridge -p ctbook -p cardtrader-price-cache )
RELEASE="$BASE/releases/${COMMIT:0:12}"
mkdir -p "$RELEASE"
for bin in pokoin-cardtrader-listing-dump pokoin-cardtrader-bridge ctbook pokoin-cardtrader-price-cache; do
  install -m 0755 "$TARGET/release/$bin" "$RELEASE/$bin"
done
newest=$(objdump -T "$RELEASE/pokoin-cardtrader-bridge" | grep -o 'GLIBC_2\.[0-9]*' | sed 's/GLIBC_2\.//' | sort -n | tail -1)
(( ${newest:-0} <= 35 )) || die "bridge needs GLIBC_2.$newest; Oracle has glibc 2.35"

scp -q "$RELEASE/pokoin-cardtrader-bridge" "$ORACLE:/home/ubuntu/bin/.pokoin-cardtrader-bridge.new"
ssh "$ORACLE" 'chmod 0755 ~/bin/.pokoin-cardtrader-bridge.new && mv -f ~/bin/.pokoin-cardtrader-bridge.new ~/bin/pokoin-cardtrader-bridge'
# Empty stdin: loads the token, starts no request, exits 0.
ssh "$ORACLE" '/home/ubuntu/bin/pokoin-cardtrader-bridge </dev/null' || die "bridge does not start on $ORACLE"

ln -sfn "releases/${COMMIT:0:12}" "$BASE/current.new"
mv -Tf "$BASE/current.new" "$BASE/current"
# Keep the three newest releases.
ls -1t "$BASE/releases" | tail -n +4 | while read -r old; do rm -rf "${BASE:?}/releases/$old"; done
echo "cardtrader dump ${COMMIT:0:12} installed: $BASE/current, $ORACLE:~/bin/pokoin-cardtrader-bridge"
