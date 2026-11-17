#!/usr/bin/env bash
# Tests for scripts/run-flow-tests.sh. Builds a throwaway git repo with fake crates, a fake psql and a fake cargo
# (given through PSQL= and CARGO=) that record every call in one file, and canned output chosen per binary. No
# cargo, no docker, no database, no network. Usage: bash scripts/run-flow-tests.test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/run-flow-tests-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

repo=$tmp/repo
bin=$tmp/bin
canned=$tmp/canned
calls=$tmp/calls.txt
out=$tmp/out.txt
admin_base=postgres://postgres:test@127.0.0.1:5432
admin=$admin_base/postgres

# ---- the fakes ---------------------------------------------------------------------------------------------
# Both record their arguments and the two database variables, so a case can assert what the script actually passed.
mkdir -p "$bin"
cat >"$bin/psql" <<'FAKE'
#!/usr/bin/env bash
{
    printf 'psql'
    for a in "$@"; do printf ' <%s>' "$a"; done
    printf '\n'
    printf 'psql POKOIN_TEST_DATABASE_URL=%s POKOIN_PRICE_EXPORT_TEST_DATABASE_URL=%s\n' \
        "${POKOIN_TEST_DATABASE_URL:-}" "${POKOIN_PRICE_EXPORT_TEST_DATABASE_URL:-}"
} >>"$CALLS"
exit 0
FAKE
cat >"$bin/cargo" <<'FAKE'
#!/usr/bin/env bash
{
    printf 'cargo'
    for a in "$@"; do printf ' <%s>' "$a"; done
    printf '\n'
    printf 'cargo POKOIN_TEST_DATABASE_URL=%s POKOIN_PRICE_EXPORT_TEST_DATABASE_URL=%s PWD=%s\n' \
        "${POKOIN_TEST_DATABASE_URL:-}" "${POKOIN_PRICE_EXPORT_TEST_DATABASE_URL:-}" "$PWD"
} >>"$CALLS"
target=
previous=
for a in "$@"; do
    if [ "$previous" = --test ]; then target=$a; fi
    previous=$a
done
if [ -f "$CANNED/$target.out" ]; then
    cat "$CANNED/$target.out"
else
    printf 'test a_case ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s\n'
fi
rc=0
if [ -f "$CANNED/$target.rc" ]; then rc=$(cat "$CANNED/$target.rc"); fi
exit "$rc"
FAKE
cat >"$bin/psql-fails" <<'FAKE'
#!/usr/bin/env bash
printf 'psql-fails %s\n' "$*" >>"$CALLS"
echo 'fake psql: permission denied to create database' >&2
exit 1
FAKE
chmod +x "$bin/psql" "$bin/cargo" "$bin/psql-fails"

# ---- the throwaway workspace -------------------------------------------------------------------------------
# crates/renamed-dir is the crate whose directory name is NOT its package name. The [dependencies] decoy proves the
# package name comes from the [package] section only.
new_repo() { # new_repo <directory> <flow|noflow>
    local r=$1 kind=$2
    mkdir -p "$r/pokoin-rust/crates/alpha/tests" "$r/pokoin-rust/crates/renamed-dir/tests" "$r/scripts"
    printf '[package]\nname = "pokoin-alpha"\nversion = "0.1.0"\nedition = "2021"\n' \
        >"$r/pokoin-rust/crates/alpha/Cargo.toml"
    printf '[package]\nname = "pokoin-different-package"\nversion = "0.1.0"\nedition = "2021"\n\n[[bin]]\nname = "decoy-bin"\npath = "src/main.rs"\n\n[dependencies]\nname = "decoy-dependency"\n' \
        >"$r/pokoin-rust/crates/renamed-dir/Cargo.toml"
    if [ "$kind" = flow ]; then
        : >"$r/pokoin-rust/crates/alpha/tests/one_flow.rs"
        : >"$r/pokoin-rust/crates/alpha/tests/two_flow.rs"
        : >"$r/pokoin-rust/crates/renamed-dir/tests/three_flow.rs"
    else
        : >"$r/pokoin-rust/crates/alpha/tests/unit.rs"
    fi
    cp "$here/run-flow-tests.sh" "$r/scripts/run-flow-tests.sh"
    (
        cd "$r"
        git init -q
        git config user.email test@example.invalid
        git config user.name test
        git add -A
        git commit -qm base
    )
}
new_repo "$repo" flow
empty_repo=$tmp/empty-repo
new_repo "$empty_repo" noflow
saved_repo=$repo

# ---- helpers -----------------------------------------------------------------------------------------------
pass=0
fail=0
rc=0

reset_case() { rm -rf "$canned"; mkdir -p "$canned"; }
canned_out() { printf '%s\n' "$2" >"$canned/$1.out"; }
canned_rc() { printf '%s' "$2" >"$canned/$1.rc"; }

run_tests() { # run_tests [extra env assignment or -u NAME ...]: the copied script in $repo against the fakes
    rc=0
    : >"$calls"
    (
        cd "$repo"
        env "POKOIN_FLOW_ADMIN_URL=$admin" "PSQL=$bin/psql" "CARGO=$bin/cargo" "CALLS=$calls" "CANNED=$canned" "$@" \
            bash scripts/run-flow-tests.sh
    ) >"$out" 2>&1 || rc=$?
}

ok() { pass=$((pass + 1)); echo "ok   - $1"; }
bad() {
    fail=$((fail + 1))
    echo "FAIL - $1"
    sed 's/^/       | /' "$out" | tail -20
    sed 's/^/  calls | /' "$calls"
}
expect_rc() { if [ "$rc" = "$1" ]; then ok "$2 (exit $1)"; else bad "$2: exit $rc, wanted $1"; fi; }
want() { if grep -qF -- "$1" "$out"; then ok "$2"; else bad "$2: no '$1' in the output"; fi; }
want_re() { if grep -qE -- "$1" "$out"; then ok "$2"; else bad "$2: no row matching '$1'"; fi; }
unwant() { if grep -qF -- "$1" "$out"; then bad "$2: '$1' should not be in the output"; else ok "$2"; fi; }
want_calls() { if grep -qF -- "$1" "$calls"; then ok "$2"; else bad "$2: no '$1' in the calls"; fi; }
want_calls_re() { if grep -qE -- "$1" "$calls"; then ok "$2"; else bad "$2: no call matching '$1'"; fi; }
unwant_calls() { if grep -qF -- "$1" "$calls"; then bad "$2: '$1' was called"; else ok "$2"; fi; }
want_no_calls() { if [ -s "$calls" ]; then bad "$1: a fake was called"; else ok "$1"; fi; }

# 1. All three binaries green: exit 0 and one table row each.
reset_case
run_tests
expect_rc 0 "every binary ok"
want "run-flow-tests: 3 of 3 binaries ok" "the count line"
want_re '^one_flow +pokoin-alpha +ok +1' "one_flow is ok with 1 passed"
want_re '^two_flow +pokoin-alpha +ok +1' "two_flow is ok with 1 passed"
want_re '^three_flow +pokoin-different-package +ok +1' "three_flow is ok with 1 passed"

# 2. Each cargo call got its OWN database, in both variables, and psql was asked to create exactly that database.
reset_case
run_tests
expect_rc 0 "one database per binary"
db_one=$admin_base/flow_one
db_two=$admin_base/flow_two
db_three=$admin_base/flow_three
want_calls "cargo POKOIN_TEST_DATABASE_URL=$db_one POKOIN_PRICE_EXPORT_TEST_DATABASE_URL=$db_one" \
    "one_flow: both database variables name flow_one"
want_calls "cargo POKOIN_TEST_DATABASE_URL=$db_two POKOIN_PRICE_EXPORT_TEST_DATABASE_URL=$db_two" \
    "two_flow: both database variables name flow_two"
want_calls "cargo POKOIN_TEST_DATABASE_URL=$db_three POKOIN_PRICE_EXPORT_TEST_DATABASE_URL=$db_three" \
    "three_flow: both database variables name flow_three"
want_calls "<create database \"flow_one\">" "psql was asked to create exactly flow_one"
want_calls "<create database \"flow_two\">" "psql was asked to create exactly flow_two"
want_calls "<create database \"flow_three\">" "psql was asked to create exactly flow_three"
want_calls "psql <$admin>" "psql itself only ever gets the admin URL"
unwant_calls "DATABASE_URL=$admin " "no binary is pointed at the shared admin database"
want_calls "<--test> <one_flow> <--> <--nocapture>" "cargo is called with --test <name>_flow -- --nocapture"
want_calls_re 'cargo .* PWD=[^ ]*/pokoin-rust$' "cargo runs from pokoin-rust/"

# 3. One binary red: exit 1, but the other two still run.
reset_case
canned_out two_flow 'test a_case ... FAILED
thread '"'"'a_case'"'"' panicked at crates/alpha/tests/two_flow.rs:12:5: assertion failed'
canned_rc two_flow 1
run_tests
expect_rc 1 "a red binary fails the run"
want_re '^two_flow +pokoin-alpha +FAILED' "the red binary is FAILED in the table"
want_re '^one_flow +pokoin-alpha +ok' "the binary before it still counts ok"
want_re '^three_flow +pokoin-different-package +ok' "the binaries after it still ran"
want_calls "<--test> <three_flow>" "cargo really ran the last binary"
want "run-flow-tests: 2 of 3 binaries ok" "the count line reports two greens"

# 4. A `skipped:` line with cargo green is a guard that returned early, never a pass.
reset_case
canned_out one_flow 'skipped: POKOIN_TEST_DATABASE_URL is not set'
run_tests
expect_rc 1 "a skipped binary is not ok"
want_re '^one_flow +pokoin-alpha +SKIPPED-INSIDE' "the row says SKIPPED-INSIDE"
want_re '^two_flow +pokoin-alpha +ok' "the other binaries are unaffected"
want "run-flow-tests: 2 of 3 binaries ok" "the skipped binary is not counted ok"

# 5. `test result: ok.` with zero passed tests is not a pass either.
reset_case
canned_out three_flow 'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s'
run_tests
expect_rc 1 "no test executed"
want_re '^three_flow +pokoin-different-package +NO-TESTS' "the row says NO-TESTS"
want "run-flow-tests: 2 of 3 binaries ok" "the empty binary is not counted ok"

# 6. The package name comes from the [package] name of Cargo.toml, never the directory or another section.
reset_case
run_tests
expect_rc 0 "the package name comes from Cargo.toml"
want_calls "<-p> <pokoin-different-package> <--locked> <--test> <three_flow>" \
    "the crate whose directory is renamed-dir is the package pokoin-different-package"
unwant_calls "<renamed-dir>" "the directory name is never used as a package"
unwant_calls "<decoy-bin>" "the [[bin]] name is never used as a package"
unwant_calls "<decoy-dependency>" "a name from another section is never used as a package"

# 7. A tree with no flow test file at all is a failure, not an empty success.
reset_case
repo=$empty_repo
run_tests
repo=$saved_repo
expect_rc 1 "zero binaries found"
want "finding zero binaries is a failure" "the reason is printed"
want_no_calls "nothing is called when there is nothing to run"

# 8. Without the admin URL the run is refused. (env cannot unset what it also sets, so this call is spelled out.)
reset_case
: >"$calls"
rc=0
(
    cd "$repo"
    env -u POKOIN_FLOW_ADMIN_URL "PSQL=$bin/psql" "CARGO=$bin/cargo" "CALLS=$calls" "CANNED=$canned" \
        bash scripts/run-flow-tests.sh
) >"$out" 2>&1 || rc=$?
expect_rc 2 "POKOIN_FLOW_ADMIN_URL unset"
want "POKOIN_FLOW_ADMIN_URL is not set" "the missing variable is named"
want_no_calls "a refusal calls nothing"

# 9. A URL whose host is not this machine is refused before anything is created.
reset_case
run_tests "POKOIN_FLOW_ADMIN_URL=postgres://postgres:test@db.example.com:5432/postgres"
expect_rc 2 "a remote host is refused"
want "host 'db.example.com'" "the refused host is printed"
want_no_calls "neither fake was called for a remote host"

# 10. When the database cannot be created the binary is FAILED, and every other binary still runs.
reset_case
run_tests "PSQL=$bin/psql-fails"
expect_rc 1 "a database that cannot be created"
want_re '^one_flow +pokoin-alpha +FAILED' "one_flow is FAILED, not silently ok"
want_re '^three_flow +pokoin-different-package +FAILED' "three_flow is FAILED too"
want "run-flow-tests: 0 of 3 binaries ok" "no binary counts ok"
unwant_calls "<--test>" "cargo never runs against a database that does not exist"

# 11. --list only discovers: no database, no cargo, and it needs no variables at all.
reset_case
: >"$calls"
rc=0
(cd "$repo" && bash scripts/run-flow-tests.sh --list) >"$out" 2>&1 || rc=$?
expect_rc 0 "--list needs no database"
want "$(printf 'one_flow\tpokoin-alpha\tflow_one')" "--list prints the triple for one_flow"
want "$(printf 'three_flow\tpokoin-different-package\tflow_three')" "--list prints the triple for three_flow"
want_no_calls "--list calls neither psql nor cargo"

# 12. Every host a throwaway Postgres really has is accepted, and the database name is the only part replaced.
reset_case
run_tests "POKOIN_FLOW_ADMIN_URL=postgres://postgres:test@localhost:5432/postgres"
expect_rc 0 "localhost is accepted"
want_calls "cargo POKOIN_TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/flow_one" \
    "localhost: only the database name changed"
reset_case
run_tests "POKOIN_FLOW_ADMIN_URL=postgres://postgres:test@[::1]:5432/postgres"
expect_rc 0 "the bracketed ::1 is accepted"
want_calls "<create database \"flow_two\">" "bracketed ::1: the databases are still created"
reset_case
run_tests "POKOIN_FLOW_ADMIN_URL=postgres://postgres:test@127.0.0.1:5432/postgres?connect_timeout=3"
expect_rc 0 "options on the admin URL are accepted"
want_calls "cargo POKOIN_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5432/flow_three?connect_timeout=3" \
    "a query string survives the database name being replaced"

echo
echo "run-flow-tests.test: $pass ok, $fail fail"
[ "$fail" = 0 ] || exit 1
