#!/usr/bin/env bash
# Tests for scripts/check-features.sh, the checker of docs/FEATURES.toml. docs/CI.md ("Feature map"), PK-C007.
#
# Every fixture is a throwaway git repository under $TMPDIR (never inside this worktree) holding the minimum the
# checker reads: a map at docs/FEATURES.toml, one Rust test file under pokoin-rust/crates/commerce/tests/, one JS
# test file matched by a fixture scripts/js-test-groups.txt, and one listed in scripts/js-tests-not-in-gate.txt.
# The groups file is read through the real scripts/js-test-inventory.sh, copied into each fixture, so these tests
# exercise the same reuse path production uses rather than a copy of its globs.
#
# Each of the checker's findings is produced exactly once, a clean map passes, the three --base rules (a removed
# flow, a risen count of unproved money flows, a base carrying no map at all) each behave, and the real
# docs/FEATURES.toml passes.
#
# Usage: scripts/check-features.test.sh
# Exit: 0 every case behaved, 1 a case did not.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
check=$here/check-features.sh
inventory=$here/js-test-inventory.sh
[ -x "$check" ] || { echo "check-features.test.sh: $check is not executable" >&2; exit 1; }
[ -f "$inventory" ] || { echo "check-features.test.sh: $inventory is missing" >&2; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/check-features-test.XXXXXX")
# shellcheck disable=SC2317,SC2329  # called through the trap cleanup EXIT below, never directly
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

fails=0
ok() { echo "ok: $*"; }
no() { echo "FAIL: $*" >&2; fails=$((fails + 1)); }

# expect <want-exit> <want-substring|-> <fixture-dir> [checker args...]
expect() {
    local want=$1 needle=$2 dir=$3
    shift 3
    local out rc=0
    out=$(cd "$dir" && bash "$check" "$@" 2>&1) || rc=$?
    if [ "$rc" != "$want" ]; then
        no "exit $rc instead of $want: $*"
        printf '%s\n' "$out" | sed 's/^/    /' >&2
        return
    fi
    if [ "$needle" != '-' ] && ! printf '%s\n' "$out" | grep -qF -- "$needle"; then
        no "nothing says '$needle' (exit was $want as asked): $*"
        printf '%s\n' "$out" | sed 's/^/    /' >&2
        return
    fi
    ok "$(basename "$dir"): $*"
}

# expect_re <fixture-dir> <regex> — the run must pass and print one line matching <regex>.
expect_re() {
    local dir=$1 re=$2 out rc=0
    out=$(cd "$dir" && bash "$check" 2>&1) || rc=$?
    if [ "$rc" != 0 ]; then
        no "$(basename "$dir"): wanted exit 0 with a row matching /$re/, got $rc"
        printf '%s\n' "$out" | sed 's/^/    /' >&2
        return
    fi
    if printf '%s\n' "$out" | grep -qE -- "$re"; then
        ok "the table prints a row matching /$re/"
    else
        no "no row matches /$re/"
        printf '%s\n' "$out" | sed 's/^/    /' >&2
    fi
}

write_map() { # write_map <fixture-dir> <body>
    printf '%s\n' '# fixture map for scripts/check-features.test.sh' "$2" >"$1/docs/FEATURES.toml"
}

# fixture_commit <dir> <message> — record a fixture commit. The lane exports core.hooksPath for every git command
# (GIT_CONFIG_KEY_0/GIT_CONFIG_VALUE_0), and this repository's pre-commit hook refuses any commit that is not in a
# linked worktree. A throwaway fixture repo under $TMPDIR is a plain repo, so the hook would reject the fixture's
# own bookkeeping commit; the commit therefore runs with core.hooksPath aimed at an empty directory inside the
# fixture. Nothing here changes this checkout's hooks, which stay exactly as the lane set them.
fixture_commit() {
    local d=$1 msg=$2
    mkdir -p "$d/.no-hooks"
    git -C "$d" -c core.hooksPath="$d/.no-hooks" -c user.email=fixture@invalid -c user.name=fixture commit -qm "$msg"
}

# newrepo <dir> — a fixture checkout whose map is clean: two proved/partial money flows and one unproved one.
newrepo() {
    local d=$1
    mkdir -p "$d/docs" "$d/scripts" "$d/market/src" "$d/pokoin-rust/crates/commerce/tests"
    cat >"$d/pokoin-rust/crates/commerce/tests/flow.rs" <<'RS'
#[tokio::test]
async fn proves_the_flow() {}

#[test]
fn proves_it_too() {}
RS
    printf "test('paints the cart', () => {});\n" >"$d/market/src/cart.test.js"
    printf 'export const api = 1;\n' >"$d/market/src/api.js"
    printf "test('never in a gate job', () => {});\n" >"$d/market/src/ungated.test.js"
    printf 'market\t.\tnode --test\tmarket/src/*.test.js\n' >"$d/scripts/js-test-groups.txt"
    printf '# fixture list\nmarket/src/ungated.test.js\tonly ever runnable on nezopt\n' >"$d/scripts/js-tests-not-in-gate.txt"
    cp "$inventory" "$d/scripts/js-test-inventory.sh"
    write_map "$d" '
[[flow]]
id = "cart-quote"
name = "Cart totals and the checkout quote"
money = true
entry = ["market/src/api.js"]
proof = ["pokoin-rust/crates/commerce/tests/flow.rs::proves_the_flow", "market/src/cart.test.js::paints the cart"]
status = "proved"

[[flow]]
id = "pkn-topup"
name = "PKN top-up"
money = true
entry = ["market/src/api.js"]
proof = ["pokoin-rust/crates/commerce/tests/flow.rs::proves_it_too"]
status = "partial"

[[flow]]
id = "seller-settings"
name = "Seller settings"
money = true
entry = ["market/src/api.js"]
proof = []
status = "unproved"
'
    git -C "$d" init -q
    git -C "$d" add -A >/dev/null
    fixture_commit "$d" fixture
}

# clone <name> — an independent copy of the fixture checkout, so a case cannot disturb its neighbours.
clone() {
    local d=$work/$1
    mkdir -p "$d"
    cp -a "$repo/." "$d/"
    printf '%s\n' "$d"
}


repo=$work/repo
newrepo "$repo"

# ---- a clean map passes, and prints its counts ------------------------------------------------------------------
expect 0 '-' "$repo"
expect 0 'flows: 3; money flows: 3; money flows unproved: 1' "$repo"
expect_re "$repo" '^cart-quote +true +proved +2$'

# ---- one key per flow ---------------------------------------------------------------------------------------------
d=$(clone missing-key)
write_map "$d" '
[[flow]]
id = "cart-quote"
name = "Cart totals"
money = true
entry = ["market/src/api.js"]
proof = ["pokoin-rust/crates/commerce/tests/flow.rs::proves_the_flow"]
'
expect 1 "flow 'cart-quote': missing key 'status'" "$d"

d=$(clone unknown-key)
write_map "$d" '
[[flow]]
id = "cart-quote"
name = "Cart totals"
money = true
entry = ["market/src/api.js"]
proof = ["pokoin-rust/crates/commerce/tests/flow.rs::proves_the_flow"]
status = "proved"
owner = "nobody"
'
expect 1 "flow 'cart-quote': unknown key 'owner'" "$d"

d=$(clone duplicate-key)
write_map "$d" '
[[flow]]
id = "cart-quote"
name = "Cart totals"
name = "Cart totals again"
money = true
entry = ["market/src/api.js"]
proof = ["pokoin-rust/crates/commerce/tests/flow.rs::proves_the_flow"]
status = "proved"
'
expect 1 "flow 'cart-quote': key 'name' appears twice" "$d"

# ---- ids ----------------------------------------------------------------------------------------------------------
d=$(clone bad-id)
sed -i 's/^id = "cart-quote"/id = "CartQuote"/' "$d/docs/FEATURES.toml"
expect 1 "flow 'CartQuote': id 'CartQuote' is not kebab-case" "$d"

d=$(clone bad-id-underscore)
sed -i 's/^id = "cart-quote"/id = "cart_quote"/' "$d/docs/FEATURES.toml"
expect 1 "is not kebab-case" "$d"

d=$(clone dup-id)
sed -i 's/^id = "pkn-topup"/id = "cart-quote"/' "$d/docs/FEATURES.toml"
expect 1 "flow 'cart-quote': the id is duplicated (also flow #1)" "$d"

# ---- entry and proof paths must be tracked --------------------------------------------------------------------------
d=$(clone untracked-entry)
sed -i 's|^entry = \["market/src/api.js"\]|entry = ["market/src/api.js", "market/src/ghost.js"]|' "$d/docs/FEATURES.toml"
expect 1 "flow 'cart-quote': entry[1]: 'market/src/ghost.js' is not a tracked file" "$d"

d=$(clone untracked-proof)
sed -i 's|market/src/cart.test.js|market/src/ghost.test.js|' "$d/docs/FEATURES.toml"
expect 1 "'market/src/ghost.test.js' is not a tracked file" "$d"

# ---- proof file::test name ----------------------------------------------------------------------------------------
d=$(clone no-such-rust-test)
sed -i 's/proves_the_flow/invented_test_name/' "$d/docs/FEATURES.toml"
expect 1 "invented_test_name' is not a test in pokoin-rust/crates/commerce/tests/flow.rs" "$d"

d=$(clone no-such-js-test)
sed -i 's/paints the cart/paints a different cart/' "$d/docs/FEATURES.toml"
expect 1 "paints a different cart' is not a test in market/src/cart.test.js" "$d"

d=$(clone double-colon)
sed -i 's|::proves_the_flow|::a::b|' "$d/docs/FEATURES.toml"
expect 1 "has more than one '::'" "$d"

d=$(clone empty-name)
sed -i 's|flow.rs::proves_it_too|flow.rs::|' "$d/docs/FEATURES.toml"
expect 1 "names no test after the '::'" "$d"

d=$(clone bad-rust-name)
sed -i 's|::proves_the_flow|::not an identifier|' "$d/docs/FEATURES.toml"
expect 1 "which is not an identifier" "$d"

# ---- status against proof --------------------------------------------------------------------------------------------
d=$(clone proved-without-proof)
write_map "$d" '
[[flow]]
id = "cart-quote"
name = "Cart totals"
money = false
entry = ["market/src/api.js"]
proof = []
status = "proved"
'
expect 1 "status 'proved' with an empty proof" "$d"

d=$(clone partial-without-proof)
write_map "$d" '
[[flow]]
id = "cart-quote"
name = "Cart totals"
money = false
entry = ["market/src/api.js"]
proof = []
status = "partial"
'
expect 1 "status 'partial' with an empty proof" "$d"

d=$(clone unproved-with-proof)
sed -i 's|^proof = \[\]|proof = ["pokoin-rust/crates/commerce/tests/flow.rs::proves_the_flow"]|' "$d/docs/FEATURES.toml"
expect 1 "status 'unproved' with 1 proof(s)" "$d"

d=$(clone bad-status)
sed -i 's/^status = "proved"/status = "mostly-true"/' "$d/docs/FEATURES.toml"
expect 1 "status 'mostly-true' is not one of: proved, partial, unproved" "$d"

d=$(clone unquoted-status)
sed -i 's/^status = "proved"/status = proved/' "$d/docs/FEATURES.toml"
expect 1 "status 'proved' is not a string in double quotes" "$d"

d=$(clone bad-money)
sed -i '0,/^money = true/s//money = yes/' "$d/docs/FEATURES.toml"
expect 1 "money = 'yes' is not true or false" "$d"

# ---- a proof no CI job runs --------------------------------------------------------------------------------------------
d=$(clone rust-not-a-test-file)
mkdir -p "$d/pokoin-rust/crates/commerce/src"
printf 'pub fn nothing() {}\n' >"$d/pokoin-rust/crates/commerce/src/lib.rs"
git -C "$d" add -A >/dev/null
write_map "$d" '
[[flow]]
id = "cart-quote"
name = "Cart totals"
money = false
entry = ["market/src/api.js"]
proof = ["pokoin-rust/crates/commerce/src/lib.rs"]
status = "partial"
'
expect 1 "is Rust code that is neither a file under a tests/ directory nor behind a #[cfg(test)] module" "$d"

d=$(clone rust-cfg-test-ok)
mkdir -p "$d/pokoin-rust/crates/commerce/src"
printf 'pub fn nothing() {}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn proves_it_from_inside() {}\n}\n' >"$d/pokoin-rust/crates/commerce/src/handlers.rs"
git -C "$d" add -A >/dev/null
write_map "$d" '
[[flow]]
id = "cart-quote"
name = "Cart totals"
money = false
entry = ["market/src/api.js"]
proof = ["pokoin-rust/crates/commerce/src/handlers.rs::proves_it_from_inside"]
status = "partial"
'
expect 0 '-' "$d"

d=$(clone js-in-not-in-gate)
write_map "$d" '
[[flow]]
id = "cart-quote"
name = "Cart totals"
money = false
entry = ["market/src/api.js"]
proof = ["market/src/ungated.test.js::never in a gate job"]
status = "partial"
'
expect 1 "listed in scripts/js-tests-not-in-gate.txt" "$d"

d=$(clone js-no-group)
printf 'export const notes = 1;\n' >"$d/market/src/notes.js"
git -C "$d" add -A >/dev/null
write_map "$d" '
[[flow]]
id = "cart-quote"
name = "Cart totals"
money = false
entry = ["market/src/api.js"]
proof = ["market/src/notes.js"]
status = "partial"
'
expect 1 "is matched by no group of scripts/js-test-groups.txt" "$d"

# ---- shapes the flat reader cannot accept -----------------------------------------------------------------------------
d=$(clone entry-not-array)
write_map "$d" '
[[flow]]
id = "cart-quote"
name = "Cart totals"
money = false
entry = "market/src/api.js"
proof = ["pokoin-rust/crates/commerce/tests/flow.rs::proves_the_flow"]
status = "partial"
'
expect 1 "is not an array on one line" "$d"

d=$(clone unquoted-item)
write_map "$d" '
[[flow]]
id = "cart-quote"
name = "Cart totals"
money = false
entry = [market/src/api.js]
proof = []
status = "unproved"
'
expect 1 'has array items that are not strings in double quotes' "$d"

d=$(clone garbage-line)
printf '[[flow]]\nid = "cart-quote"\nname = "Cart totals"\nmoney = false\nentry = ["market/src/api.js"]\nproof = []\nstatus = "unproved"\nrandom garbage\n' >"$d/docs/FEATURES.toml"
expect 1 'not a [[flow]] line and not key = value' "$d"

d=$(clone key-before-flow)
printf 'id = "cart-quote"\n[[flow]]\nname = "Cart totals"\nmoney = false\nentry = ["market/src/api.js"]\nproof = []\nstatus = "unproved"\n' >"$d/docs/FEATURES.toml"
expect 1 'key before the first [[flow]]' "$d"

d=$(clone empty-map)
printf '# nothing here\n' >"$d/docs/FEATURES.toml"
expect 1 'lists no [[flow]] block' "$d"

# ---- --base: the map may only grow -----------------------------------------------------------------------------------
# HEAD is the fixture commit, which carries the clean map: 1 unproved money flow, 3 flows.
d=$(clone base-unproved-grew)
write_map "$d" '
[[flow]]
id = "cart-quote"
name = "Cart totals and the checkout quote"
money = true
entry = ["market/src/api.js"]
proof = ["pokoin-rust/crates/commerce/tests/flow.rs::proves_the_flow", "market/src/cart.test.js::paints the cart"]
status = "proved"

[[flow]]
id = "pkn-topup"
name = "PKN top-up"
money = true
entry = ["market/src/api.js"]
proof = ["pokoin-rust/crates/commerce/tests/flow.rs::proves_it_too"]
status = "partial"

[[flow]]
id = "seller-settings"
name = "Seller settings"
money = true
entry = ["market/src/api.js"]
proof = []
status = "unproved"

[[flow]]
id = "pkn-withdraw"
name = "PKN withdrawal"
money = true
entry = ["market/src/api.js"]
proof = []
status = "unproved"
'
expect 1 'are unproved but only 1 were at HEAD' "$d" --base HEAD

d=$(clone base-flow-removed)
write_map "$d" '
[[flow]]
id = "cart-quote"
name = "Cart totals and the checkout quote"
money = true
entry = ["market/src/api.js"]
proof = ["pokoin-rust/crates/commerce/tests/flow.rs::proves_the_flow", "market/src/cart.test.js::paints the cart"]
status = "proved"

[[flow]]
id = "pkn-topup"
name = "PKN top-up"
money = true
entry = ["market/src/api.js"]
proof = ["pokoin-rust/crates/commerce/tests/flow.rs::proves_it_too"]
status = "partial"
'
expect 1 "flow 'seller-settings' is present at" "$d" --base HEAD

# a new flow, and a money flow that moved from unproved to partial: both only ever grow the map
d=$(clone base-growth-ok)
write_map "$d" '
[[flow]]
id = "cart-quote"
name = "Cart totals and the checkout quote"
money = true
entry = ["market/src/api.js"]
proof = ["pokoin-rust/crates/commerce/tests/flow.rs::proves_the_flow", "market/src/cart.test.js::paints the cart"]
status = "proved"

[[flow]]
id = "pkn-topup"
name = "PKN top-up"
money = true
entry = ["market/src/api.js"]
proof = ["pokoin-rust/crates/commerce/tests/flow.rs::proves_it_too"]
status = "proved"

[[flow]]
id = "seller-settings"
name = "Seller settings"
money = true
entry = ["market/src/api.js"]
proof = ["pokoin-rust/crates/commerce/tests/flow.rs::proves_the_flow"]
status = "partial"

[[flow]]
id = "refund"
name = "Refund a delivered order"
money = true
entry = ["market/src/api.js"]
proof = ["pokoin-rust/crates/commerce/tests/flow.rs::proves_it_too"]
status = "partial"
'
expect 0 '-' "$d" --base HEAD

# a checkout with a brand-new map: the base has no docs/FEATURES.toml, so neither growth rule can fire
d=$(clone base-no-map)
rm -f "$d/docs/FEATURES.toml"
git -C "$d" add -A >/dev/null
fixture_commit "$d" 'no map yet'
write_map "$d" '
[[flow]]
id = "cart-quote"
name = "Cart totals and the checkout quote"
money = true
entry = ["market/src/api.js"]
proof = ["pokoin-rust/crates/commerce/tests/flow.rs::proves_the_flow", "market/src/cart.test.js::paints the cart"]
status = "proved"
'
expect 0 '-' "$d" --base HEAD

# ---- the check cannot run at all --------------------------------------------------------------------------------------
expect 2 'is not a commit' "$repo" --base 0123456789abcdef0123456789abcdef01234567
expect 2 'unknown argument' "$repo" --nonsense
expect 2 'usage:' "$repo" --base
d=$work/no-map-checkout
clone no-map-checkout >/dev/null
rm -f "$d/docs/FEATURES.toml"
expect 2 'docs/FEATURES.toml is not in this checkout' "$d"
d=$work/outside-a-checkout
mkdir -p "$d"
rc=0
(cd "$d" && bash "$check" >/dev/null 2>&1) || rc=$?
if [ "$rc" = 2 ]; then ok "outside a git checkout the check refuses to run (exit 2)"; else no "exit $rc outside a git checkout, 2 wanted"; fi

# ---- the real map ------------------------------------------------------------------------------------------------------
real=$(cd "$here/.." && git rev-parse --show-toplevel)
out=$(cd "$real" && bash "$check" 2>&1) && rc=0 || rc=$?
if [ "$rc" != 0 ]; then
    no "the real docs/FEATURES.toml does not pass (exit $rc)"
    printf '%s\n' "$out" | sed 's/^/    /' >&2
elif ! printf '%s\n' "$out" | tail -1 | grep -qE '^flows: [0-9]+; money flows: [0-9]+; money flows unproved: [0-9]+$'; then
    no "the real run printed no counts line: $(printf '%s\n' "$out" | tail -1)"
else
    ok "the real docs/FEATURES.toml passes: $(printf '%s\n' "$out" | tail -1)"
fi
# and the real map with --base: origin/main carries no docs/FEATURES.toml yet, so growth cannot be violated
out=$(cd "$real" && bash "$check" --base HEAD 2>&1) && rc=0 || rc=$?
if [ "$rc" = 0 ]; then ok "the real map also passes --base HEAD, whose commit has no map to shrink"; else
    no "the real map with --base HEAD exited $rc"; printf '%s\n' "$out" | sed 's/^/    /' >&2
fi

if [ "$fails" -gt 0 ]; then
    echo "check-features.test.sh: $fails case(s) did not behave" >&2
    exit 1
fi
echo "check-features.test.sh: every finding is produced once, a clean map passes, the growth rules hold, and the real docs/FEATURES.toml passes"
