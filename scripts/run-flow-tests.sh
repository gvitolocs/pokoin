#!/usr/bin/env bash
# Runs every database-backed `*_flow` test binary of the Rust workspace, each one in its own throwaway Postgres
# database, and ends with one table. docs/CI.md ("flow-db"), PK-R003 (PKN-03, PKN-04, PKN-05).
#
# Usage: POKOIN_FLOW_ADMIN_URL=postgres://postgres:test@127.0.0.1:5432/postgres scripts/run-flow-tests.sh [--list]
#   --list   print the discovered <binary> <package> <database> triples and exit 0, without touching a database
#
# POKOIN_FLOW_ADMIN_URL is the only database this script connects to: a Postgres whose user may create and drop
# databases. Its host must be 127.0.0.1, localhost or ::1, so a wrong variable can never point the run at a real
# server. Each binary gets a fresh database named flow_<name> (dropped first if an older run left one); the created
# databases are kept afterwards, so a red one can be inspected by hand. PSQL and CARGO name the binaries to call,
# which is what scripts/run-flow-tests.test.sh fakes.
#
# A binary is NOT ok when `cargo test` exits non-zero, when its output has a line starting with `skipped:` (a guard
# returned early, so nothing was asserted), or when its output has no `test result: ok.` line with at least one
# passed test. That last rule is what stops a binary whose own database variable is unset from counting as green.
# Both database variables are exported for every call, so `price_export_flow` really runs instead of skipping.
# Every binary runs even after one is not ok.
# Exit: 0 every binary ok, 1 a binary is not ok or the tree has no flow test, 2 refused to start.
set -euo pipefail

die() { echo "run-flow-tests: $*" >&2; exit 2; }
usage() { echo "usage: POKOIN_FLOW_ADMIN_URL=<localhost postgres URL> $0 [--list]" >&2; exit "${1:-2}"; }

list_only=0
while [ $# -gt 0 ]; do
    case "$1" in
        --list) list_only=1; shift ;;
        -h | --help) usage 0 ;;
        *) echo "run-flow-tests: unknown argument: $1" >&2; usage ;;
    esac
done

root=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel 2>/dev/null) || die "not inside a git checkout"
rust_dir=$root/pokoin-rust

# ---- discovery: the flow binaries come from the tree, never from a list written in this script ---------------
# The cargo package of each is the [package] name of that crate's Cargo.toml, not a guess from the directory name
# (pokoin-rust/crates/commerce is the package pokoin-commerce).
BINARIES=()
PACKAGES=()
SHORTS=()
discover() {
    local file crate manifest binary short pkg
    while IFS= read -r file; do
        [ -n "$file" ] || continue
        # git's glob * also spans '/', so the shape is checked here rather than trusted: exactly one crate
        # directory, the tests/ directory, a bare <name>_flow.rs in it.
        [[ $file =~ ^pokoin-rust/crates/([^/]+)/tests/([^/]+)_flow\.rs$ ]] \
            || die "unexpected flow test file path: $file"
        crate=pokoin-rust/crates/${BASH_REMATCH[1]}
        binary=${BASH_REMATCH[2]}_flow
        short=${BASH_REMATCH[2]}
        [[ $short =~ ^[a-z0-9_]+$ ]] || die "unexpected flow test file name: $file"
        manifest=$root/$crate/Cargo.toml
        [ -f "$manifest" ] || die "no Cargo.toml for $file"
        pkg=$(awk '
            /^\[package\]/ { inpkg = 1; next }
            /^\[/ { inpkg = 0 }
            inpkg && /^name[ \t]*=/ {
                sub(/^[^=]*=[ \t]*/, "")
                gsub(/^"|"$/, "")
                print
                exit
            }' "$manifest")
        [ -n "$pkg" ] || die "no [package] name in $crate/Cargo.toml"
        BINARIES+=("$binary")
        PACKAGES+=("$pkg")
        SHORTS+=("$short")
    done < <(git -C "$root" ls-files 'pokoin-rust/crates/*/tests/*_flow.rs' | LC_ALL=C sort)
}

discover
if [ "${#BINARIES[@]}" -eq 0 ]; then
    echo "run-flow-tests: the tree has no pokoin-rust/crates/*/tests/*_flow.rs file; finding zero binaries is a failure" >&2
    exit 1
fi

if [ "$list_only" = 1 ]; then
    n=0
    while [ "$n" -lt "${#BINARIES[@]}" ]; do
        printf '%s\t%s\tflow_%s\n' "${BINARIES[$n]}" "${PACKAGES[$n]}" "${SHORTS[$n]}"
        n=$((n + 1))
    done
    exit 0
fi

# ---- the admin URL: required, and only ever a throwaway Postgres on this machine -----------------------------
admin_url=${POKOIN_FLOW_ADMIN_URL:-}
if [ -z "$admin_url" ]; then
    die "POKOIN_FLOW_ADMIN_URL is not set; it must be a Postgres URL whose user may create databases, e.g. postgres://postgres:test@127.0.0.1:5432/postgres (scripts/check-fast --db starts one)"
fi
if [[ $admin_url != *"://"* ]]; then
    die "POKOIN_FLOW_ADMIN_URL has no scheme://; it is not a database URL"
fi
scheme=${admin_url%%://*}
rest=${admin_url#*://}
if [[ $rest == */* ]]; then
    authority=${rest%%/*}
    path_and_query=${rest#*/}
else
    authority=$rest
    path_and_query=""
fi
hostport=${authority##*@}
if [[ $hostport == \[*\]* ]]; then
    host=${hostport%%]*}          # [::1] or [::1]:5432
    host=${host#\[}
elif [[ $hostport == *:*:* ]]; then
    host=$hostport               # a bare IPv6 address, which cannot carry a plain :port
else
    host=${hostport%%:*}         # hostname or IPv4, with or without :port
fi
if [ -z "$host" ]; then
    die "POKOIN_FLOW_ADMIN_URL has no host this script can read ('$admin_url'); the URL of a throwaway Postgres looks like postgres://postgres:test@127.0.0.1:5432/postgres"
fi
case $host in
    127.0.0.1 | localhost | ::1) ;;
    *) die "POKOIN_FLOW_ADMIN_URL has host '$host': this script creates and drops databases, so it refuses any host but 127.0.0.1, localhost or ::1" ;;
esac

# The admin URL with only its database name replaced: credentials, port and options are kept.
db_url() {
    local db=$1 opts=""
    if [[ $path_and_query == *\?* ]]; then opts="?${path_and_query#*\?}"; fi
    printf '%s://%s/%s%s\n' "$scheme" "$authority" "$db" "$opts"
}

psql_bin=${PSQL:-psql}
cargo_bin=${CARGO:-cargo}
command -v "$psql_bin" >/dev/null 2>&1 || die "psql not found ($psql_bin): this is a failure, never a skip"
command -v "$cargo_bin" >/dev/null 2>&1 || die "cargo not found ($cargo_bin): this is a failure, never a skip"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/run-flow-tests.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# ---- one fresh database and one cargo call per binary, in sorted order --------------------------------------
VERDICTS=()
PASSED_COUNTS=()
DURATIONS=()
ok_count=0
i=0
while [ "$i" -lt "${#BINARIES[@]}" ]; do
    binary=${BINARIES[$i]}
    pkg=${PACKAGES[$i]}
    db=flow_${SHORTS[$i]}
    url=$(db_url "$db")
    log=$tmp/$binary.log
    started=$SECONDS
    echo "=== $binary ($pkg) in $db"

    rc=0
    "$psql_bin" "$admin_url" -v ON_ERROR_STOP=1 \
        -c "drop database if exists \"$db\"" \
        -c "create database \"$db\"" >>"$log" 2>&1 || rc=$?
    if [ "$rc" = 0 ]; then
        (
            cd "$rust_dir" || exit 97
            export POKOIN_TEST_DATABASE_URL="$url"
            export POKOIN_PRICE_EXPORT_TEST_DATABASE_URL="$url"
            "$cargo_bin" test -p "$pkg" --locked --test "$binary" -- --nocapture
        ) >>"$log" 2>&1 || rc=$?
    else
        echo "run-flow-tests: creating $db failed, so $binary was not run" >>"$log"
    fi
    DURATIONS[i]=$((SECONDS - started))
    cat "$log"
    passed=$(sed -n 's/^test result: ok\. \([0-9]\{1,\}\) passed.*/\1/p' "$log" | awk '{ s += $1 } END { print s + 0 }')
    if [ "$rc" != 0 ]; then
        verdict=FAILED
    elif grep -qE '^skipped:' "$log"; then
        verdict=SKIPPED-INSIDE
    elif [ "$passed" -gt 0 ]; then
        verdict=ok
    else
        verdict=NO-TESTS
    fi
    if [ "$verdict" = ok ]; then ok_count=$((ok_count + 1)); fi
    VERDICTS[i]=$verdict
    PASSED_COUNTS[i]=$passed
    i=$((i + 1))
done

# ---- one table for the whole run ---------------------------------------------------------------------------
printf '\n%-28s %-22s %-15s %7s %9s\n' binary package result passed seconds
i=0
while [ "$i" -lt "${#BINARIES[@]}" ]; do
    printf '%-28s %-22s %-15s %7s %8ss\n' "${BINARIES[$i]}" "${PACKAGES[$i]}" "${VERDICTS[$i]}" "${PASSED_COUNTS[$i]}" "${DURATIONS[$i]}"
    i=$((i + 1))
done
echo "run-flow-tests: $ok_count of ${#BINARIES[@]} binaries ok"
[ "$ok_count" -eq "${#BINARIES[@]}" ] || exit 1
