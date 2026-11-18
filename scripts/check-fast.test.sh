#!/usr/bin/env bash
# Tests for scripts/check-fast. Builds a throwaway git repo in a temp dir with a tiny cargo crate (no
# dependencies, no network) and runs a copy of the script against it. Never touches the real workspace.
# Usage: bash scripts/check-fast.test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/check-fast-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
repo=$tmp/repo
export POKOIN_CHECK_TARGET=$tmp/target
export POKOIN_CHECK_MIN_FREE_GB=1
export POKOIN_DIFFGATE=$tmp/no-such-diffgate
# shellcheck disable=SC1091
command -v cargo >/dev/null 2>&1 || . "$HOME/.cargo/env"

mkdir -p "$repo/pokoin-rust/crates/demo/src" "$repo/scripts"
cat >"$repo/pokoin-rust/Cargo.toml" <<'EOF'
[workspace]
resolver = "2"
members = ["crates/demo"]

[workspace.package]
version = "0.1.0"
edition = "2021"
EOF
cat >"$repo/pokoin-rust/crates/demo/Cargo.toml" <<'EOF'
[package]
name = "demo-crate"
version.workspace = true
edition.workspace = true
EOF
# Old debt in the base: an unformatted line and a clippy warning (ptr_arg).
cat >"$repo/pokoin-rust/crates/demo/src/lib.rs" <<'EOF'
pub fn good() -> u32 {
    1
}

pub fn  old_ugly( )->u32{ 2 }

pub fn old_clippy(v: &Vec<u32>) -> usize {
    v.len()
}

#[cfg(test)]
mod tests {
    #[test]
    fn works() {
        assert_eq!(super::good(), 1);
    }
}
EOF
# Old debt in a shell script: unquoted $1 (SC2086).
cat >"$repo/scripts/old.sh" <<'EOF'
#!/usr/bin/env bash
set -eu
echo $1
EOF
cp "$here/check-fast" "$repo/scripts/check-fast"
chmod +x "$repo/scripts/check-fast"
(
    cd "$repo"
    git init -q -b main
    git config user.email test@example.invalid
    git config user.name test
    cargo generate-lockfile --offline --manifest-path pokoin-rust/Cargo.toml >/dev/null 2>&1
    git add -A
    git commit -qm base
)

pass=0
fail=0
out=$tmp/out.txt
rc=0

reset() { (cd "$repo" && git checkout -q -- . && git clean -fdq); }

# add_item TEXT: puts new code in lib.rs before the test module (clippy dislikes items after it).
add_item() {
    local lib=$repo/pokoin-rust/crates/demo/src/lib.rs
    awk -v add="$1" '/^#\[cfg\(test\)\]/ && !done { print add; print ""; done = 1 } { print }' "$lib" >"$lib.new"
    mv "$lib.new" "$lib"
}

# run_check [args...]: runs the copied script, keeps output in $out and the exit code in $rc.
run_check() {
    rc=0
    (cd "$repo" && bash scripts/check-fast --base HEAD "$@") >"$out" 2>&1 || rc=$?
}

ok() { pass=$((pass + 1)); echo "ok   - $1"; }
bad() {
    fail=$((fail + 1))
    echo "FAIL - $1"
    sed 's/^/       | /' "$out"
}
expect_rc() { if [ "$rc" = "$1" ]; then ok "$2 (exit $1)"; else bad "$2: exit $rc, wanted $1"; fi; }
expect_row() { # step status description
    if grep -Eq "^$1 +$2( |$)" "$out"; then ok "$3"; else bad "$3: no '$1 $2' row"; fi
}

# 1. Nothing changed: nothing runs, nothing counts as passed.
reset
run_check
expect_rc 0 "no change"
expect_row rustfmt SKIPPED "no change: rustfmt SKIPPED, not PASS"

# 2. A well-formatted, warning-free new function passes although old debt sits in the same file.
reset
add_item $'pub fn fresh() -> u32 {\n    3\n}'
run_check
expect_rc 0 "clean new line beside old debt"
expect_row rustfmt PASS "old unformatted line in a touched file does not fail rustfmt"
expect_row clippy PASS "old clippy warning does not fail clippy"
expect_row test PASS "unit tests of the touched crate run and pass"

# 3. An unformatted NEW line fails.
reset
add_item 'pub fn  new_ugly( )->u32{ 3 }'
run_check --no-build
expect_rc 1 "unformatted new line"
expect_row rustfmt FAIL "unformatted new line: rustfmt FAIL"

# 4. Editing the old unformatted line (still unformatted) fails: the line is now modified.
reset
sed -i 's/{ 2 }/{ 4 }/' "$repo/pokoin-rust/crates/demo/src/lib.rs"
run_check --no-build
expect_rc 1 "modified unformatted line"
expect_row rustfmt FAIL "modified old line: rustfmt FAIL"

# 5. A new unformatted untracked file fails: every line of it is new.
reset
printf 'pub fn  extra( )->u32{ 5 }\n' >"$repo/pokoin-rust/crates/demo/src/extra.rs"
run_check --no-build
expect_rc 1 "untracked unformatted file"
expect_row rustfmt FAIL "untracked file: rustfmt FAIL"

# 6. A new clippy warning fails, rustfmt stays quiet.
reset
add_item $'pub fn new_clippy(v: &Vec<u32>) -> usize {\n    v.len()\n}'
run_check --no-test
expect_rc 1 "new clippy warning"
expect_row clippy FAIL "new clippy warning: clippy FAIL"
expect_row rustfmt PASS "new clippy warning: rustfmt PASS"
expect_row test SKIPPED "--no-test: test SKIPPED"

# 7. A failing unit test fails the test step.
reset
printf '\n#[cfg(test)]\nmod more {\n    #[test]\n    fn breaks() {\n        assert_eq!(1, 2);\n    }\n}\n' >>"$repo/pokoin-rust/crates/demo/src/lib.rs"
run_check
expect_rc 1 "failing test"
expect_row test FAIL "failing test: test FAIL"

# 8. A missing tool is SKIPPED with its reason, never PASS, and does not fail the run.
reset
stub=$tmp/stubbin
mkdir -p "$stub"
for t in git bash python3 awk sed head grep cat dirname mktemp rm df tail tr seq sleep diff tar mkdir cp env; do
    ln -sf "$(command -v "$t")" "$stub/$t"
done
printf '#!/usr/bin/env bash\necho hi\n' >"$repo/scripts/new.sh"
rc=0
(cd "$repo" && PATH=$stub bash scripts/check-fast --base HEAD --no-build) >"$out" 2>&1 || rc=$?
expect_rc 0 "tools missing"
expect_row shellcheck SKIPPED "missing shellcheck: SKIPPED"
expect_row gitleaks SKIPPED "missing gitleaks: SKIPPED"
if grep -q 'shellcheck not installed' "$out"; then ok "the SKIPPED row names the reason"; else bad "no reason on the SKIPPED row"; fi

# 9. shellcheck: old finding in an untouched line passes, a new one fails.
if command -v shellcheck >/dev/null 2>&1; then
    reset
    printf 'echo finished\n' >>"$repo/scripts/old.sh"
    run_check --no-build
    expect_rc 0 "clean new shell line beside old finding"
    expect_row shellcheck PASS "old shellcheck finding does not fail"
    reset
    # shellcheck disable=SC2016
    printf 'echo $2\n' >>"$repo/scripts/old.sh"
    run_check --no-build
    expect_rc 1 "new shellcheck finding"
    expect_row shellcheck FAIL "new shellcheck finding: FAIL"
else
    echo "skip - shellcheck is not installed: shell line filter untested"
fi

# 10. Refuses to build with too little free disk (exit 2), and rejects unknown arguments (exit 2).
reset
add_item $'pub fn fresh() -> u32 {\n    3\n}'
rc=0
(cd "$repo" && POKOIN_CHECK_MIN_FREE_GB=99999999 bash scripts/check-fast --base HEAD) >"$out" 2>&1 || rc=$?
expect_rc 2 "low disk refuses to build"
if grep -q 'refusing to build' "$out"; then ok "low disk message"; else bad "no low disk message"; fi
run_check --bogus
expect_rc 2 "unknown argument"

# 11. A change outside pokoin-rust/ does not run the Rust steps.
reset
echo note >"$repo/NOTE.md"
run_check
expect_rc 0 "change outside pokoin-rust"
expect_row clippy SKIPPED "no crate touched: clippy SKIPPED"

echo
echo "check-fast.test: $pass passed, $fail failed"
[ "$fail" = 0 ]
