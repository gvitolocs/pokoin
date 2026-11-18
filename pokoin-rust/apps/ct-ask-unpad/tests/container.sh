#!/usr/bin/env bash
# The fixture test of ct-ask-unpad against a throwaway Postgres 17: start a
# container, run `cargo test --test fixture` against it, remove the container
# again — including when the test fails or is interrupted.
#
# Nothing here speaks to a real database. The container publishes on a loopback
# port chosen by the kernel and its data directory is a tmpfs that dies with it,
# so the only rows the test can reach are the ones it seeds itself.
#
#   pokoin-rust/apps/ct-ask-unpad/tests/container.sh
#   pokoin-rust/apps/ct-ask-unpad/tests/container.sh --nocapture   # print the plan
set -euo pipefail

crate_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
rust_dir="$(cd "$crate_dir/../.." && pwd)"
image="${POSTGRES_IMAGE:-postgres:17-alpine}"

command -v docker >/dev/null 2>&1 || {
    echo "docker is not installed: the fixture test cannot run" >&2
    exit 1
}
export TMPDIR="${TMPDIR:-$HOME/scratch/tmp}"
mkdir -p "$TMPDIR"

pg_name="ct-ask-unpad-test-$$"
# Only the container this run started, by the name it gave it, and always: the
# trap fires on success, on failure and on interrupt.
trap 'docker rm -f "$pg_name" >/dev/null 2>&1 || true' EXIT INT TERM

# Let the daemon pick a free loopback port and read it back: the test must never
# collide with a dev server of another workspace.
docker run -d --rm --name "$pg_name" -e POSTGRES_PASSWORD=test -p "127.0.0.1::5432" \
    --tmpfs /var/lib/postgresql/data "$image" >/dev/null
port=$(docker port "$pg_name" 5432/tcp | head -n 1)
port="${port##*:}"
if [ -z "$port" ]; then
    echo "$image started but published no port" >&2
    exit 1
fi

ready=0
for _ in $(seq 1 90); do
    if docker exec "$pg_name" pg_isready -q -h 127.0.0.1 -U postgres; then
        ready=1
        break
    fi
    sleep 1
done
if [ "$ready" != 1 ]; then
    echo "$image did not become ready on 127.0.0.1:$port in 90 s" >&2
    exit 1
fi

export CT_ASK_UNPAD_TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:$port/postgres"
echo "== fixture test of ct-ask-unpad on $image at 127.0.0.1:$port"
cd "$rust_dir"
status=0
cargo test --offline --locked -p ct-ask-unpad --test fixture -- "$@" || status=$?
echo "== fixture test finished with status $status; $pg_name is removed"
exit "$status"
