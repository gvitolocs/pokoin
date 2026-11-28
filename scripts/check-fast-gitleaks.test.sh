#!/usr/bin/env bash
# Run: bash scripts/check-fast-gitleaks.test.sh
#
# Regression for the gitleaks step of scripts/check-fast. That step copies the changed files into a temporary
# directory and scans the copy with `gitleaks detect --no-git`, and gitleaks takes its configuration from the scanned
# directory: unless the step names the repository's .gitleaks.toml with -c, its allowlists are invisible and a dummy
# key the repository allowlists comes back as a leak.
#
# The step reads the configuration from the base commit, never from the branch: a branch that plants a key and adds
# an allowlist line for it to its own .gitleaks.toml must still fail. Every case therefore builds a base commit and a
# branch commit and hands the step the base.
#
# Only step_gitleaks runs here, lifted out of scripts/check-fast so this tests the real code; the rest of check-fast
# needs cargo, python and a Rust workspace and belongs to scripts/check-fast.test.sh. Every case works in a throwaway
# git repo whose base .gitleaks.toml allowlists one line by regex, exactly as the repository does.
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
base_sha=
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
        # shellcheck disable=SC2034
        base=$base_sha
        # root, base, tmp, live and REASON are what check-fast hands the step; shellcheck cannot see the sourced body
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
# core.hooksPath is forced empty: a host that sets it globally (scripts/setup-git-hooks.sh, or a CI lane that wraps
# this repository's own hooks) would run its guards inside this fixture and refuse the base commit, because a fresh
# git init is a main work tree.
gitq() { git -C "$repo" -c user.name=t -c user.email=t@example.invalid -c core.hooksPath= "$@"; }

# A 64 hex character key: what the generic-api-key rule of the default gitleaks ruleset reports.
hex=0123456789abcdef
key=""
for i in $(seq 0 63); do key+=${hex:$(((i * 7 + 3) % 16)):1}; done

# write_config <with|without|none|real>: the repository policy, with or without the allowlist entry for the fixture
# line, absent, or a copy of the repository's own.
write_config() {
    case "$1" in
        with)
            cat >"$repo/.gitleaks.toml" <<'EOF'
[extend]
useDefault = true

[[allowlists]]
description = "dummy encryption key set inside a test"
regexTarget = "line"
regexes = ['''std::env::set_var\("DEMO_TOKEN_ENCRYPTION_KEY"''']
EOF
            ;;
        without) printf '[extend]\nuseDefault = true\n' >"$repo/.gitleaks.toml" ;;
        real) cp "$here/../.gitleaks.toml" "$repo/.gitleaks.toml" ;;
        none) rm -f "$repo/.gitleaks.toml" ;;
    esac
}
# write_fixture <name> <env var> [extra]: a changed file holding the key on a line that sets <env var>, and with
# "extra" a second key on a line the allowlist does not name.
write_fixture() {
    {
        echo '#[cfg(test)]'
        echo 'mod t {'
        echo '    fn f() {'
        echo "        std::env::set_var(\"$2\", \"$key\");"
        if [ "${3:-}" = extra ]; then
            echo "        std::env::set_var(\"OTHER_TOKEN_ENCRYPTION_KEY\", \"$key\");"
        fi
        echo '    }'
        echo '}'
    } >"$repo/fixtures/$1"
}
# new_repo <base config>: a fresh repository whose base commit carries that configuration, left on a branch.
new_repo() {
    rm -rf "$repo"
    mkdir -p "$repo/fixtures" "$work"
    gitq init -q -b main
    echo base >"$repo/README"
    write_config "$1"
    gitq add -A
    gitq commit -qm base
    base_sha=$(gitq rev-parse HEAD)
    gitq checkout -q -b branch
}
# commit_branch: the branch commit, every change in the work tree.
commit_branch() {
    gitq add -A
    gitq commit -qm branch
}

# ---- 1. the bug itself, outside the step: the same scan with and without -c ------------------------------------
new_repo with
write_fixture zero.rs DEMO_TOKEN_ENCRYPTION_KEY
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

# ---- a. the base allowlists the line, the branch adds it: pass ---------------------------------------------------
new_repo with
write_fixture zero.rs DEMO_TOKEN_ENCRYPTION_KEY
commit_branch
run_step fixtures/zero.rs
expect_pass "a. base allowlists the line the branch adds"

# ---- the allowlist stays narrow: a key on a line it does not name still fails -----------------------------------
new_repo with
write_fixture zero.rs DEMO_TOKEN_ENCRYPTION_KEY extra
commit_branch
run_step fixtures/zero.rs
expect_fail "second key on a non-allowlisted line"

# ---- b. the base has no allowlist entry: fail --------------------------------------------------------------------
new_repo without
write_fixture zero.rs DEMO_TOKEN_ENCRYPTION_KEY
commit_branch
run_step fixtures/zero.rs
expect_fail "b. base has no allowlist entry"

# ---- c. the branch plants the key and allowlists it in its own .gitleaks.toml: fail ------------------------------
new_repo without
write_fixture zero.rs DEMO_TOKEN_ENCRYPTION_KEY
write_config with
commit_branch
run_step fixtures/zero.rs .gitleaks.toml
expect_fail "c. the branch allowlists its own key"

# ---- d. the base has no .gitleaks.toml: the default rules, and the note says so ----------------------------------
new_repo none
write_fixture zero.rs DEMO_TOKEN_ENCRYPTION_KEY
write_config with
commit_branch
run_step fixtures/zero.rs
expect_fail "d. base has no configuration file"
if grep -q 'base commit has no .gitleaks.toml' "$out"; then
    ok "d. the note says the base commit has no .gitleaks.toml"
else
    bad "d. the missing configuration prints no note"
fi

# ---- e. the real repository policy allows the line that reported the false positive ------------------------------
new_repo real
write_fixture zero.rs CARDTRADER_TOKEN_ENCRYPTION_KEY
commit_branch
run_step fixtures/zero.rs
expect_pass "e. the real .gitleaks.toml allows the line it allowlists"

echo
echo "check-fast-gitleaks.test: $pass passed, $fails failed"
[ "$fails" = 0 ]
