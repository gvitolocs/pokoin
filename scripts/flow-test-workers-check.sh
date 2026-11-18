#!/usr/bin/env bash
# Closes the PKN-09 class: no Rust test may build the commerce router and leave its production background
# workers running. docs/CI.md ("flow-db"), PK-R027 (PKN-09, studied by PK-R024).
#
# `pokoin_commerce::router()` is not a pure constructor: it starts three workers. A test that calls it only to
# exercise one handler therefore spawns the writers too, and `tests/seller_snapshot_flow.rs` was racing its own
# assertion against the seller-book sweep until it failed about one run in five. Every test that builds the
# router must switch all three off next to its database guard:
#
#     std::env::set_var("POKOIN_LISTING_SYNC_WORKER", "0");
#     std::env::set_var("POKOIN_SELLER_WEBHOOK_WORKER", "0");
#     std::env::set_var("POKOIN_SELLER_BOOK_WORKER", "0");
#
# or carry one line in scripts/flow-test-workers-exceptions.txt saying which worker it needs running and why.
#
# Which call forms count as "builds the commerce router" — the ones the tree actually uses, plus the import that
# would hide the call:
#   pokoin_commerce::router(...)      every commerce test does it this way (whitespace inside the path allowed)
#   use pokoin_commerce::router ...;  or use pokoin_commerce::{router, ...}; followed by a bare router(...)
# Another crate's router (pokoin_catalog_api::router, or a test's own local `router`) is not this class and is
# ignored, which is why the crate name is part of the pattern rather than a bare `router(`.
#
# The three names are never trusted blindly:
#   * the check fails if the commerce source stops containing one of them, so a renamed switch cannot turn this
#     script into a no-op;
#   * the check fails if router() no longer starts exactly one worker per listed name. The count is awk over the
#     body of `pub fn router(` — the lines from the signature to the first brace in column 0 — matching `start(`
#     at a word boundary. That body is one flat function today (lib.rs:69-71), so a fourth worker added to
#     router() shows up there as a fourth call and this script must learn its switch name.
#
# Usage: scripts/flow-test-workers-check.sh [--base <commit>]
#   --base   fail on any exception line this commit does not already carry: a new exception ships only with the
#            owner's logged override. A reworded reason is a different line and counts as new. A base without
#            the exceptions file has nothing to compare against, so no line of the current file is new.
# Exit: 0 clean, 1 a finding, 2 this check cannot run.
set -euo pipefail

crate=pokoin-rust/crates/commerce
lib=$crate/src/lib.rs
src=$crate/src
exceptions=scripts/flow-test-workers-exceptions.txt
workers=(POKOIN_SELLER_BOOK_WORKER POKOIN_LISTING_SYNC_WORKER POKOIN_SELLER_WEBHOOK_WORKER)
sep=$'\t'

die() { echo "flow-test-workers-check: $*" >&2; exit 2; }
usage() { echo "usage: $0 [--base <commit>]" >&2; exit "${1:-2}"; }

base=""
while [ $# -gt 0 ]; do
    case "$1" in
        --base) [ $# -ge 2 ] || usage; base=$2; shift 2 ;;
        -h | --help) usage 0 ;;
        *) echo "flow-test-workers-check: unknown argument: $1" >&2; usage ;;
    esac
done

root=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel 2>/dev/null) || die "not inside a git checkout"

# The sentence every finding ends with, with the names this script actually requires.
list=""
i=0
for name in "${workers[@]}"; do
    if [ -z "$list" ]; then list=$name
    elif [ "$((i + 1))" -eq "${#workers[@]}" ]; then list="$list and $name"
    else list="$list, $name"
    fi
    i=$((i + 1))
done
hint="a test that builds the router starts production background workers unless it switches them off: set $list to 0 next to the database guard, or list the file with its reason"

findings=0
fail() { # fail <what is wrong> <the sentence to print after it, or empty>
    echo "flow-test-workers-check: $1" >&2
    [ -z "${2:-}" ] || echo "flow-test-workers-check: $2" >&2
    findings=$((findings + 1))
}

sets_zero() { # sets_zero <tracked path> <variable>: the file sets that variable to "0"
    grep -qE "set_var!?[[:space:]]*\([[:space:]]*\"$2\"[[:space:]]*,[[:space:]]*\"0\"[[:space:]]*\)" "$root/$1"
}

# ---- the switch names are still the ones the product reads ------------------------------------------------
if [ ! -f "$root/$lib" ]; then
    echo "flow-test-workers-check: $lib is not in this checkout, so the workers router() starts cannot be counted" >&2
    exit 1
fi
for name in "${workers[@]}"; do
    if ! grep -rqF -- "$name" "$root/$src"; then
        fail "$name is read nowhere under $src: a renamed or removed switch must not turn this check into a no-op. Name the switch router()'s worker reads today, here and in every router test."
    fi
done
starts=$(awk '
    /^pub fn router\(/ { inside = 1; next }
    inside && /^\}/ { inside = 0 }
    inside && /(^|[^A-Za-z0-9_])start\(/ { n++ }
    END { print n + 0 }' "$root/$lib")
if [ "$starts" != "${#workers[@]}" ]; then
    fail "$lib starts $starts worker(s) inside router() while this script lists ${#workers[@]} switch(es) ($list): every worker router() starts needs its switch name here and in every test that builds the router."
fi

# ---- the tests that build the commerce router -------------------------------------------------------------
router_re='pokoin_commerce[[:space:]]*::[[:space:]]*router[[:space:]]*\(|^[[:space:]]*use[[:space:]]+pokoin_commerce[[:space:]]*::[[:space:]]*(router|\{[^}]*router)'
TESTS=()
while IFS= read -r file; do
    # git's glob * also spans '/', so the shape is checked here rather than trusted: exactly one crate
    # directory, the tests/ directory, one bare .rs file in it.
    [[ $file =~ ^pokoin-rust/crates/[^/]+/tests/[^/]+\.rs$ ]] || continue
    [ -f "$root/$file" ] || continue
    if grep -qE -- "$router_re" "$root/$file"; then TESTS+=("$file"); fi
done < <(git -C "$root" ls-files 'pokoin-rust/crates/*/tests/*.rs')

if [ "${#TESTS[@]}" -eq 0 ]; then
    echo "flow-test-workers-check: no tracked test under pokoin-rust/crates/*/tests/ builds $crate's router; finding none is a failure, never a pass" >&2
    exit 1
fi

# ---- the exceptions ---------------------------------------------------------------------------------------
declare -A allowed=()
declare -A current_lines=()
exception_file=$root/$exceptions
if [ -f "$exception_file" ]; then
    number=0
    while IFS= read -r line || [ -n "$line" ]; do
        number=$((number + 1))
        [ -n "${line//[[:space:]]/}" ] || continue
        [[ $line == \#* ]] && continue
        current_lines["$line"]=1
        if [[ ! $line =~ $'\t'.*$'\t' ]]; then
            fail "$exceptions:$number: '$line' is not a <file><TAB><variable><TAB><reason> line"
            continue
        fi
        file=${line%%$'\t'*}
        rest=${line#*$'\t'}
        var=${rest%%$'\t'*}
        reason=${rest#*$'\t'}
        reason=${reason#"${reason%%[![:space:]]*}"}
        reason=${reason%"${reason##*[![:space:]]}"}
        known=0
        for name in "${workers[@]}"; do
            [ "$var" != "$name" ] || known=1
        done
        if [ "$known" = 0 ]; then
            fail "$exceptions:$number: $var is not a worker this check requires (${list// /, })"
            continue
        fi
        if [ "${#reason}" -lt 15 ]; then
            fail "$exceptions:$number: the reason for $file leaving $var running is ${#reason} character(s); it must be at least 15, because this line is the whole record of why a production worker runs inside a test"
            continue
        fi
        is_router_test=0
        for test in "${TESTS[@]}"; do
            [ "$test" != "$file" ] || is_router_test=1
        done
        if [ "$is_router_test" = 0 ]; then
            if [ ! -f "$root/$file" ]; then
                fail "$exceptions:$number is stale: $file is not in this checkout any more. Delete the line."
            else
                fail "$exceptions:$number is stale: $file does not build $crate's router, so nothing may be left switched on for it. Delete the line."
            fi
            continue
        fi
        if sets_zero "$file" "$var"; then
            fail "$exceptions:$number is stale: $file switches $var off itself. Delete the line."
            continue
        fi
        allowed["$file$sep$var"]=1
    done < "$exception_file"
fi

# ---- the requirement --------------------------------------------------------------------------------------
for file in "${TESTS[@]}"; do
    for name in "${workers[@]}"; do
        sets_zero "$file" "$name" && continue
        [ -z "${allowed["$file$sep$name"]:-}" ] || continue
        fail "$file leaves $name running" "$hint"
    done
done

# ---- a new exception needs the owner's override -----------------------------------------------------------
if [ -n "$base" ]; then
    git -C "$root" rev-parse --verify --quiet "${base}^{commit}" >/dev/null \
        || die "--base '$base' is not a commit in this checkout"
    if base_exceptions=$(git -C "$root" show "$base:$exceptions" 2>/dev/null); then
        declare -A base_lines=()
        while IFS= read -r line; do
            [ -n "${line//[[:space:]]/}" ] || continue
            [[ $line == \#* ]] && continue
            base_lines["$line"]=1
        done <<<"$base_exceptions"
        for line in "${!current_lines[@]}"; do
            [ -n "${base_lines["$line"]:-}" ] \
                || fail "a new exception ships only with the owner's logged override: '${line//$'\t'/ }'"
        done
    fi
fi

if [ "$findings" -gt 0 ]; then
    echo "flow-test-workers-check: $findings finding(s)" >&2
    exit 1
fi
echo "flow-test-workers-check: ${#TESTS[@]} tracked test(s) build $crate's router and every one of them switches off all ${#workers[@]} workers"
