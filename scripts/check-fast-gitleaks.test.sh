#!/usr/bin/env bash
# Run: bash scripts/check-fast-gitleaks.test.sh
#
# Regression for the gitleaks step of scripts/check-fast. That step copies the changed files into a temporary
# directory and scans the copy with `gitleaks detect --no-git`, and gitleaks takes its configuration from the scanned
# directory: unless the step names the repository's .gitleaks.toml with -c, its allowlists are invisible and a dummy
# key the repository allowlists comes back as a leak.
#
# Only step_gitleaks runs here, lifted out of scripts/check-fast so this tests the real code; the rest of check-fast
# needs cargo, python and a Rust workspace and belongs to scripts/check-fast.test.sh. Every case works in a throwaway
# git repo whose committed .gitleaks.toml allowlists one line by regex, exactly as the repository does: the config is
# not one of the changed files, so it is nowhere inside the scanned copy.
#
# The dummy key is assembled at run time, so this file itself scans clean.
# Exits 0 with a SKIPPED line when gitleaks is not installed: the step skips itself then, so there is nothing to prove.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
export TMPDIR=${TMPDIR:-$HOME/scratch/tmp}
mkdir -p "$TMPDIR"
box=$(mktemp -d "$TMPDIR/check-fast-gitleaks-test.XXXXXX")
# The trap runs on a failing case too, so the throwaway repo never survives the run.
trap 'rm -rf "$box"' EXIT

if ! command -v gitleaks >/dev/null 2>&1; then
    echo "SKIPPED: gitleaks is not installed, so the check-fast gitleaks step is not tested here"
    exit 0
fi

pass=0
fails=0
out=$box/out.txt
work=$box/work
repo=$box/repo
rc=0
ok() { pass=$((pass + 1)); echo "ok   - $1"; }
bad() {
    fails=$((fails + 1))
    echo "FAIL - $1"
    if [ -f "$out" ]; then sed 's/^/       | /' "$out"; fi
}

# ---- the step under test --------------------------------------------------------------------------------------
step_script=$box/step_gitleaks.sh
awk '/^step_gitleaks\(\) \{/ { f = 1 } f { print } f && /^\}/ { exit }' "$here/check-fast" >"$step_script"
if ! grep -q 'step_gitleaks()' "$step_script"; then
    echo "FAIL - no step_gitleaks function found in scripts/check-fast, so there is nothing to test here"
    exit 1
fi

# run_step <changed file...>: the step as check-fast runs it. $root is the repository, $tmp the scratch directory
# whose scan/ subdirectory is what gitleaks is pointed at, live the changed files. The step's note (REASON) is
# printed, because that is where check-fast reports a missing configuration.
run_step() {
    rc=0
    (
        set -euo pipefail
        root=$repo
        # root, tmp, live and REASON are what check-fast hands the step; shellcheck cannot see the sourced body
        # that reads them.
        # shellcheck disable=SC2034
        tmp=$work
        REASON=""
        # shellcheck disable=SC2034
        live=("$@")
        mkdir -p "$root"
        cd "$root"
        # shellcheck disable=SC1090
        source "$step_script"
        step_gitleaks && rc=0 || rc=$?
        printf 'note: %s\n' "$REASON"
        exit "$rc"
    ) >"$out" 2>&1 || rc=$?
}
expect_pass() { if [ "$rc" = 0 ]; then ok "$1: the step passes"; else bad "$1: the step exited $rc, wanted 0"; fi; }
expect_fail() {
    if [ "$rc" = 1 ]; then
        ok "$1: the step fails"
    elif [ "$rc" = 3 ]; then
        bad "$1: the step SKIPPED itself instead of scanning"
    else
        bad "$1: the step exited $rc, wanted a failure"
    fi
}

# ---- the throwaway repo ---------------------------------------------------------------------------------------
mkdir -p "$repo" "$work" "$repo/fixtures"
# core.hooksPath is forced empty: a host that sets it globally (scripts/setup-git-hooks.sh, or a CI lane that wraps
# this repository's own hooks) would run its guards inside this fixture and refuse the base commit, because a fresh
# git init is a main work tree.
gitq() { git -C "$repo" -c user.name=t -c user.email=t@example.invalid -c core.hooksPath= "$@"; }
gitq init -q -b main

# A 64 hex character key: what the generic-api-key rule of the default gitleaks ruleset reports.
hex=0123456789abcdef
key=""
for i in $(seq 0 63); do key+=${hex:$(((i * 7 + 3) % 16)):1}; done

# write_config <with|without>: the repository policy, with or without the allowlist entry for the fixture line.
write_config() {
    if [ "$1" = with ]; then
        cat >"$repo/.gitleaks.toml" <<'EOF'
[extend]
useDefault = true

[[allowlists]]
description = "dummy encryption key set inside a test"
regexTarget = "line"
regexes = ['''std::env::set_var\("DEMO_TOKEN_ENCRYPTION_KEY"''']
EOF
    else
        printf '[extend]\nuseDefault = true\n' >"$repo/.gitleaks.toml"
    fi
}
# write_fixture <with|without>: a changed file holding the allowlisted line, and optionally a second key on a line
# the allowlist does not name.
write_fixture() {
    {
        echo '#[cfg(test)]'
        echo 'mod t {'
        echo '    fn f() {'
        echo "        std::env::set_var(\"DEMO_TOKEN_ENCRYPTION_KEY\", \"$key\");"
        if [ "$1" = with ]; then
            echo "        std::env::set_var(\"OTHER_TOKEN_ENCRYPTION_KEY\", \"$key\");"
        fi
        echo '    }'
        echo '}'
    } >"$repo/fixtures/zero.rs"
}
rm -f "$repo/fixtures/zero.rs"
write_config with
gitq add -A
gitq commit -qm base

# ---- 1. the bug itself, outside the step: the same scan with and without -c ------------------------------------
write_fixture without
plain=$box/plain
mkdir -p "$plain"
cp "$repo/fixtures/zero.rs" "$plain/zero.rs"
rc=0
gitleaks detect --no-git --no-banner --redact -s "$plain" >"$out" 2>&1 || rc=$?
if [ "$rc" != 0 ]; then
    ok "without -c the allowlisted line is reported (exit $rc): this is the false positive"
else
    bad "the fixture is not a false positive: the scan is clean even with no configuration, so the cases below prove nothing"
fi
rc=0
gitleaks detect --no-git --no-banner --redact -c "$repo/.gitleaks.toml" -s "$plain" >"$out" 2>&1 || rc=$?
if [ "$rc" = 0 ]; then
    ok "with -c the same scan is clean (exit 0)"
else
    bad "the fixture configuration does not allowlist the fixture line: gitleaks exits $rc"
fi

# ---- 2. the step passes on a change the repository allowlists ---------------------------------------------------
write_config with
write_fixture without
run_step fixtures/zero.rs
expect_pass "allowlisted line changed"

# ---- 3. the allowlist stays narrow: a key on a line it does not name still fails --------------------------------
write_fixture with
run_step fixtures/zero.rs
expect_fail "second key on a non-allowlisted line"

# ---- 4. the allowlist entry removed: the same line now fails -----------------------------------------------------
write_config without
write_fixture without
run_step fixtures/zero.rs
expect_fail "allowlist entry removed"

# ---- 5. no .gitleaks.toml: the old behaviour, plus one note line -------------------------------------------------
rm -f "$repo/.gitleaks.toml"
write_fixture without
run_step fixtures/zero.rs
expect_fail "no configuration file"
if grep -q 'default rules' "$out"; then
    ok "the missing configuration says the gitleaks default rules were used"
else
    bad "the missing configuration prints no note"
fi

# ---- 6. the real repository policy allows the line that reported the false positive ------------------------------
# The reported case itself: the repository's own .gitleaks.toml and the test line of cardtrader/zero.rs.
rm -f "$repo/fixtures/zero.rs"
cp "$here/../.gitleaks.toml" "$repo/.gitleaks.toml"
gitq add .gitleaks.toml
gitq commit -qm 'real repository policy'
{
    echo '#[cfg(test)]'
    echo 'mod t {'
    echo '    fn f() {'
    echo "        std::env::set_var(\"CARDTRADER_TOKEN_ENCRYPTION_KEY\", \"$key\");"
    echo '    }'
    echo '}'
} >"$repo/fixtures/zero.rs"
run_step fixtures/zero.rs
expect_pass "the real .gitleaks.toml allows the line it allowlists"

echo
echo "check-fast-gitleaks.test: $pass passed, $fails failed"
[ "$fails" = 0 ]
