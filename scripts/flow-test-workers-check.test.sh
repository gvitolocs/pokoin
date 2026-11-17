#!/usr/bin/env bash
# Tests for scripts/flow-test-workers-check.sh. Each case builds a throwaway git repository holding a fake
# commerce crate (a lib.rs whose router() starts three workers, three src files that read the three switches, and
# test files under tests/), then runs the copied check against it. Nothing here reads or builds the real
# pokoin-rust workspace: no cargo, no docker, no database, no network.
# Usage: bash scripts/flow-test-workers-check.test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/flow-test-workers-check-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

repo=$tmp/repo
out=$tmp/out.txt
tests_dir=pokoin-rust/crates/commerce/tests
src_dir=pokoin-rust/crates/commerce/src
book=pokoin-rust/crates/commerce/src/handlers/seller_book.rs
sync=pokoin-rust/crates/commerce/src/listing_sync.rs
hook=pokoin-rust/crates/commerce/src/seller_api.rs
exceptions=scripts/flow-test-workers-exceptions.txt
good=$tests_dir/seller_snapshot_flow.rs
ALL_THREE=(POKOIN_LISTING_SYNC_WORKER POKOIN_SELLER_WEBHOOK_WORKER POKOIN_SELLER_BOOK_WORKER)
# A reason long enough to satisfy the 15-character rule.
reason='the sweep is the actor under test here'

# ---- the throwaway crate ----------------------------------------------------------------------------------
fresh_repo() { # a clean, committed tree: one router test that switches all three workers off, no exception lines
    rm -rf "$repo"
    mkdir -p "$repo/$src_dir/handlers" "$repo/$tests_dir" "$repo/pokoin-rust/crates/catalog/tests" "$repo/scripts"
    cat >"$repo/$src_dir/lib.rs" <<'RS'
pub fn router(state: DomainState) -> Router {
    listing_sync::start(&state);
    seller_api::start(&state);
    handlers::seller_book::start(&state);
    Router::new()
        .route("/api/marketplace-listings", get(listings))
}
RS
    printf 'pub fn start(state: &DomainState) {\n    if std::env::var("POKOIN_LISTING_SYNC_WORKER").as_deref() == Ok("0") {\n        return;\n    }\n}\n' >"$repo/$sync"
    printf 'pub fn start(state: &DomainState) {\n    if std::env::var("POKOIN_SELLER_WEBHOOK_WORKER").as_deref() == Ok("0") {\n        return;\n    }\n}\n' >"$repo/$hook"
    printf 'pub fn start(state: &DomainState) {\n    if std::env::var("POKOIN_SELLER_BOOK_WORKER").as_deref() == Ok("0") {\n        return;\n    }\n}\n' >"$repo/$book"
    cp "$here/flow-test-workers-check.sh" "$repo/scripts/flow-test-workers-check.sh"
    printf '# Exceptions read by scripts/flow-test-workers-check.sh.\n# Nothing is exempt today.\n' >"$repo/$exceptions"
    write_test seller_snapshot_flow "${ALL_THREE[@]}"
    (
        cd "$repo"
        git init -q
        git config user.email test@example.invalid
        git config user.name test
        git add -A
        git commit -qm base
    )
}

write_test() { # write_test <file name under tests/> <variables it switches off>
    local name=$1
    shift
    local file=$repo/$tests_dir/$name.rs v
    {
        printf '%s\n' 'use tower::ServiceExt;' '' 'async fn a_case(state: DomainState) {' \
            '    let app = pokoin_commerce::router(state);'
        for v in "$@"; do printf '    std::env::set_var("%s", "0");\n' "$v"; done
        printf '%s\n' '}'
    } >"$file"
}

add_exception() { # add_exception <tracked path> <variable> <reason>
    printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$repo/$exceptions"
}

# ---- helpers ----------------------------------------------------------------------------------------------
pass=0
fail_count=0
rc=0

stage() { ( cd "$repo" && git add -A ) }
commit() { ( cd "$repo" && git add -A && git commit --allow-empty -qm "$1" ) }
base_sha() { ( cd "$repo" && git rev-parse HEAD) }

run_check() {
    rc=0
    ( cd "$repo" && bash scripts/flow-test-workers-check.sh "$@" ) >"$out" 2>&1 || rc=$?
}

ok() { pass=$((pass + 1)); echo "ok   - $1"; }
bad() {
    fail_count=$((fail_count + 1))
    echo "FAIL - $1"
    sed 's/^/       | /' "$out" | tail -20
}
expect_rc() { if [ "$rc" = "$1" ]; then ok "$2 (exit $1)"; else bad "$2: exit $rc, wanted $1"; fi; }
want() { if grep -qF -- "$1" "$out"; then ok "$2"; else bad "$2: no '$1' in the output"; fi; }
unwant() { if grep -qF -- "$1" "$out"; then bad "$2: '$1' should not be in the output"; else ok "$2"; fi; }

# 1. A router test that switches all three off is clean.
fresh_repo
run_check
expect_rc 0 "every worker switched off"
want "1 tracked test(s) build" "the clean run says what it counted"
want "every one of them switches off all 3 workers" "the clean run says what it proved"

# 2. The PKN-09 case: one switch missing, and the check names the file and the variable.
fresh_repo
write_test seller_snapshot_flow POKOIN_LISTING_SYNC_WORKER POKOIN_SELLER_WEBHOOK_WORKER
stage
run_check
expect_rc 1 "a missing switch is a finding"
want "$tests_dir/seller_snapshot_flow.rs leaves POKOIN_SELLER_BOOK_WORKER running" "the file and the variable are named"
want "a test that builds the router starts production background workers unless it switches them off: set POKOIN_SELLER_BOOK_WORKER, POKOIN_LISTING_SYNC_WORKER and POKOIN_SELLER_WEBHOOK_WORKER to 0 next to the database guard, or list the file with its reason" \
    "the required sentence is printed"

# 3. Two files missing, both reported: the run does not stop at the first.
fresh_repo
write_test seller_snapshot_flow POKOIN_LISTING_SYNC_WORKER POKOIN_SELLER_WEBHOOK_WORKER
write_test box_slots_flow POKOIN_LISTING_SYNC_WORKER POKOIN_SELLER_BOOK_WORKER
stage
run_check
expect_rc 1 "two offenders"
want "seller_snapshot_flow.rs leaves POKOIN_SELLER_BOOK_WORKER running" "the first is named"
want "box_slots_flow.rs leaves POKOIN_SELLER_WEBHOOK_WORKER running" "the second is named too"

# 4. The same file, with an exception line and a reason: clean.
fresh_repo
write_test seller_snapshot_flow POKOIN_LISTING_SYNC_WORKER POKOIN_SELLER_WEBHOOK_WORKER
add_exception "$tests_dir/seller_snapshot_flow.rs" POKOIN_SELLER_BOOK_WORKER "$reason"
stage
run_check
expect_rc 0 "an exception with a reason excuses the file"
unwant "leaves POKOIN_SELLER_BOOK_WORKER running" "nothing is reported for the exempt pair"

# 5. The exception must carry a reason of at least 15 characters.
fresh_repo
write_test seller_snapshot_flow POKOIN_LISTING_SYNC_WORKER POKOIN_SELLER_WEBHOOK_WORKER
add_exception "$tests_dir/seller_snapshot_flow.rs" POKOIN_SELLER_BOOK_WORKER "too short"
stage
run_check
expect_rc 1 "a reason of 9 characters"
want "must be at least 15" "the length rule is the finding"
want "$tests_dir/seller_snapshot_flow.rs leaves POKOIN_SELLER_BOOK_WORKER running" "the unexcused variable is still named"

# 6. A reason alone does not license a variable the file already switched off: that line is stale.
fresh_repo
add_exception "$tests_dir/seller_snapshot_flow.rs" POKOIN_SELLER_BOOK_WORKER "$reason"
stage
run_check
expect_rc 1 "an exception for a switched-off worker"
want "is stale: $tests_dir/seller_snapshot_flow.rs switches POKOIN_SELLER_BOOK_WORKER off itself" "the stale line is named"

# 7. An exception whose file is gone is stale as well.
fresh_repo
add_exception "$tests_dir/gone_flow.rs" POKOIN_SELLER_BOOK_WORKER "$reason"
stage
run_check
expect_rc 1 "an exception for a file that is not here"
want "$tests_dir/gone_flow.rs is not in this checkout any more" "the missing file is named"

# 8. --base: an exception the base does not carry needs the owner's logged override.
fresh_repo
base_commit=$(base_sha)
write_test seller_snapshot_flow POKOIN_LISTING_SYNC_WORKER POKOIN_SELLER_WEBHOOK_WORKER
add_exception "$tests_dir/seller_snapshot_flow.rs" POKOIN_SELLER_BOOK_WORKER "$reason"
stage
run_check --base "$base_commit"
expect_rc 1 "a new exception against a base"
want "a new exception ships only with the owner's logged override" "the override is demanded"
want "$tests_dir/seller_snapshot_flow.rs POKOIN_SELLER_BOOK_WORKER $reason" "the offending line is quoted"

# 9. --base controls: the same line, already in the base, passes; and a base without the file has nothing to add.
fresh_repo
write_test seller_snapshot_flow POKOIN_LISTING_SYNC_WORKER POKOIN_SELLER_WEBHOOK_WORKER
add_exception "$tests_dir/seller_snapshot_flow.rs" POKOIN_SELLER_BOOK_WORKER "$reason"
commit with-the-exception
run_check --base "$(base_sha)"
expect_rc 0 "an exception the base already carries"
fresh_repo
rm "$repo/$exceptions"
commit without-an-exceptions-file
write_test seller_snapshot_flow POKOIN_LISTING_SYNC_WORKER POKOIN_SELLER_WEBHOOK_WORKER
add_exception "$tests_dir/seller_snapshot_flow.rs" POKOIN_SELLER_BOOK_WORKER "$reason"
stage
run_check --base "$(base_sha)"
expect_rc 0 "a base without the exceptions file counts every line as present"

# 10. A test that never builds the router is none of this check's business, in any crate.
fresh_repo
cat >"$repo/$tests_dir/unit.rs" <<'RS'
#[test]
fn a_pure_function() {
    assert_eq!(super::next_slot(3), 4);
}
RS
cat >"$repo/pokoin-rust/crates/catalog/tests/satellite_flow.rs" <<'RS'
async fn a_case(state: DomainState) {
    let app = pokoin_catalog_api::router(state);
}
RS
stage
run_check
expect_rc 0 "files that do not build the commerce router are ignored"
want "1 tracked test(s) build" "only the router test was counted"

# 11. A test that imports the router and calls it bare is the same class.
fresh_repo
cat >"$repo/$tests_dir/imported_flow.rs" <<'RS'
use pokoin_commerce::router;
async fn a_case(state: DomainState) {
    let app = router(state);
}
RS
stage
run_check
expect_rc 1 "the use-import form is caught"
want "$tests_dir/imported_flow.rs leaves POKOIN_SELLER_BOOK_WORKER running" "the imported form names the file and the variable"

# 12. A renamed switch must not turn the check into a no-op.
fresh_repo
printf 'pub fn start(state: &DomainState) {\n    if std::env::var("POKOIN_SELLER_BOOK_SWEEP").as_deref() == Ok("0") {\n        return;\n    }\n}\n' >"$repo/$book"
stage
run_check
expect_rc 1 "the product no longer reads one listed name"
want "POKOIN_SELLER_BOOK_WORKER is read nowhere under $src_dir" "the dead name is named"

# 13. A worker added to router() without a listed switch fails the count, not silently.
fresh_repo
awk '{ print } /^    handlers::seller_book::start\(&state\);/ { print "    handlers::price_export::start(&state);" }' \
    "$repo/$src_dir/lib.rs" >"$tmp/lib.rs" && mv "$tmp/lib.rs" "$repo/$src_dir/lib.rs"
stage
run_check
expect_rc 1 "router() now starts four workers"
want "starts 4 worker(s) inside router() while this script lists 3" "the mismatch between starts and names is the finding"

# 14. A malformed exception line and a line for a variable this check does not require.
fresh_repo
printf '%s\n' 'pokoin-rust/crates/commerce/tests/seller_snapshot_flow.rs POKOIN_SELLER_BOOK_WORKER no tabs here' >>"$repo/$exceptions"
add_exception "$tests_dir/seller_snapshot_flow.rs" POKOIN_READ_CACHE "$reason"
stage
run_check
expect_rc 1 "a malformed line"
want "is not a <file><TAB><variable><TAB><reason> line" "the shape is required"
want "POKOIN_READ_CACHE is not a worker this check requires" "an exemption for a variable nobody asked for is refused"

# 15. A tree with no router test at all is a failure, never an empty pass.
fresh_repo
rm "$repo/$good"
cat >"$repo/$tests_dir/unit.rs" <<'RS'
#[test]
fn a_pure_function() {}
RS
stage
run_check
expect_rc 1 "zero router tests found"
want "finding none is a failure" "the reason is printed"

# 16. The real exception file the repository ships has no entries, so the real tree is checked, not excused.
fresh_repo
cp "$here/flow-test-workers-exceptions.txt" "$repo/$exceptions"
stage
run_check
expect_rc 0 "the shipped exceptions file exempts nothing"
want "1 tracked test(s) build" "the comments of that file are not lines"

echo
echo "flow-test-workers-check.test: $pass ok, $fail_count fail"
[ "$fail_count" = 0 ] || exit 1
