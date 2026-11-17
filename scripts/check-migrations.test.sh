#!/usr/bin/env bash
# Tests for scripts/check-migrations.sh (docs/CI.md, "Migration rules"). Each case builds a throwaway git
# repository holding a scripts/sql directory, commits it as the migration baseline, changes it, and runs the
# copied check over that range. Nothing here reads a database, a host or a credential: the check only ever
# runs git, awk and grep over committed trees.
#
# The fixture baseline holds 059_add_draft_table.sql (marked "-- migration: draft", so it is still editable),
# and three released migrations 060, 061, 062 — the highest number in use is therefore 062 and a new file has
# to be 063 or above.
#
# Usage: bash scripts/check-migrations.test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-$HOME/scratch/tmp}/check-migrations-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

repo=$tmp/repo
out=$tmp/out.txt
dir=scripts/sql
baseline=''

# g is every git call the fixture makes. core.hooksPath is emptied on purpose: the Paseo lane exports it at
# this repository's .githooks, whose pre-commit refuses any checkout whose git directory is also its common
# directory — which every throwaway fixture is. That refusal would be about the fixture's host, not about
# migrations, and this test never commits inside a pokoin checkout anyway.
g() { git -C "$repo" -c core.hooksPath= -c user.name=test -c user.email=test@example.invalid "$@"; }

sql() { # sql <name under scripts/sql> <line>...: a compliant -- db: writer / -- phase: expand migration
    local name=$1
    shift
    {
        printf '%s\n' '-- db: writer' '-- phase: expand'
        printf '%s\n' "$@"
    } >"$repo/$dir/$name"
}

sql_db() { # sql_db <name> <value of -- db> <line>...: the same, with the target the case asks for
    local name=$1 value=$2
    shift 2
    {
        printf '%s\n' "-- db: $value" '-- phase: expand'
        printf '%s\n' "$@"
    } >"$repo/$dir/$name"
}

commit() { g add -A && g commit --allow-empty -qm "$1"; }

fresh_repo() { # a committed baseline: three released migrations and one draft
    rm -rf "$repo"
    mkdir -p "$repo/$dir" "$repo/scripts"
    cp "$here/check-migrations.sh" "$repo/scripts/check-migrations.sh"
    sql 060_baseline_roles.sql 'create table poker.seat (id bigint primary key);'
    sql 061_baseline_grants.sql 'grant select on poker.seat to pokoin_reader;'
    sql 062_baseline_index.sql 'create index seat_id_ix on poker.seat (id);'
    printf '%s\n' '-- migration: draft' '-- db: writer' '-- phase: expand' \
        'create table poker.draft (id bigint);' >"$repo/$dir/059_add_draft_table.sql"
    g init -q .
    commit baseline
    baseline=$(g rev-parse HEAD)
}

fresh_repo_colliding() { # as fresh_repo, but the baseline itself ships one number collision
    fresh_repo
    sql 061_second_file_on_061.sql 'create table poker.also_061 (id bigint);'
    commit baseline-with-a-collision
    baseline=$(g rev-parse HEAD)
}

# ---- helpers ------------------------------------------------------------------------------------------------
pass=0
fail_count=0
rc=0

run_check() { # run_check [base]: the copied check, on the fixture's own baseline
    local base=${1:-$baseline}
    rc=0
    POKOIN_MIGRATIONS_BASELINE=$baseline bash "$repo/scripts/check-migrations.sh" --base "$base" >"$out" 2>&1 || rc=$?
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

# 1. A clean new migration passes, and the run says what it read.
fresh_repo
sql 063_new_table.sql 'create table poker.round (id bigint primary key);'
commit add-063
run_check
expect_rc 0 "a compliant new migration"
want "ok $dir/063_new_table.sql: new 063_new_table.sql above 062; db: writer; phase: expand; create at line 3" \
    "the per-file line reports the name, the number it cleared and the header"
want "every one is a numbered migration that says what it changes, on which database and in which phase" \
    "the summary states what the run proved"

# 2. A range that touches nothing under scripts/sql passes with a word about it.
fresh_repo
run_check
expect_rc 0 "nothing changed under scripts/sql"
want "nothing changed under $dir between $baseline and HEAD" "the run says there was nothing to check"
want "$dir holds 4 numbered file(s) with 0 number collision(s)" "the whole-directory rule still ran"

# 3. Rule (a): a migration the baseline released may not be edited.
fresh_repo
printf 'alter table poker.seat add column smuggled bigint;\n' >>"$repo/$dir/061_baseline_grants.sql"
commit edit-a-released-migration
run_check
expect_rc 1 "a modified baseline file"
want "$dir/061_baseline_grants.sql: it is in $dir at the migration baseline $baseline and has been modified" \
    "the edited file is named with the baseline it came from"
want "A migration on main is never edited, renamed or removed: add a new file" "the rule is stated"

# 4. Rule (a) exception: a file that was a draft at the baseline has not been applied yet.
fresh_repo
printf 'alter table poker.draft add column still_draft bigint;\n' >>"$repo/$dir/059_add_draft_table.sql"
commit edit-a-draft
run_check
expect_rc 0 "a modified file carrying -- migration: draft"
want "$dir/059_add_draft_table.sql: modified, and it carried \"-- migration: draft\" at the baseline as well as here" \
    "the exception is explained rather than silently taken"

# 5. Rule (a): dropping a released migration is the same violation.
fresh_repo
g rm -q "$dir/060_baseline_roles.sql"
commit delete-a-released-migration
run_check
expect_rc 1 "a deleted baseline file"
want "$dir/060_baseline_roles.sql: it is in $dir at the migration baseline $baseline and is deleted here" \
    "the deleted file is named"
want "A migration on main is never edited, renamed or removed" "the same sentence covers the deletion"

# 6. Deleting a file the baseline never had is fine: it was never applied.
fresh_repo
sql 070_dropped_before_release.sql 'create table poker.dropped (id bigint);'
commit add-070
mid=$(g rev-parse HEAD)
g rm -q "$dir/070_dropped_before_release.sql"
commit delete-the-range-file
run_check "$mid"
expect_rc 0 "a file added and removed before any release"
want "$dir/070_dropped_before_release.sql: deleted in range and not in scripts/sql at the baseline, so it was never released" \
    "the removal is accepted with the reason"

# 7. Rule (a): renaming a released migration is the same violation.
fresh_repo
g mv "$dir/062_baseline_index.sql" "$dir/064_renumbered_by_hand.sql"
commit rename-a-released-migration
run_check
expect_rc 1 "a renamed baseline file"
want "$dir/062_baseline_index.sql: it is in $dir at the migration baseline $baseline and has been renamed, to $dir/064_renumbered_by_hand.sql" \
    "both names are printed"
want "The 127 -> 129 renumber of PK-R004 section 1 is what this refuses" "the case that motivated the rule is named"

# 8. A rename whose source is itself new in the range is checked as the new file it is.
fresh_repo
sql 070_first_name.sql 'create table poker.renamed (id bigint);'
commit add-070
mid=$(g rev-parse HEAD)
g mv "$dir/070_first_name.sql" "$dir/071_second_name.sql"
commit rename-to-071
run_check "$mid"
expect_rc 0 "a rename of a file that is new in the range"
want "new 071_second_name.sql above 070" "the destination is checked by the naming rules"

# 9. Rule (b): a new file may not take a number that is already used.
fresh_repo
sql 062_second_feature.sql 'create table poker.reuse (id bigint);'
commit reuse-062
run_check
expect_rc 1 "a new file on a used number"
want "$dir/062_second_feature.sql: the number 062 is already used at $baseline by $dir/062_baseline_index.sql" \
    "the number and the file that holds it are named"
want "What to do: name it 063_<snake_case>.sql instead" "the free number is offered"

# 10. Rule (b): a new number must be above every number in use, gaps included.
fresh_repo
sql 005_below_the_maximum.sql 'create table poker.old_gap (id bigint);'
commit add-into-a-gap
run_check
expect_rc 1 "a number that is not above the highest in use"
want "the number 005 is not above 062, the highest number in $dir at $baseline" "the maximum is named"
want "Gaps are not free" "the reason gaps are taken is stated"

# 11. Rule (b): a dated name is refused.
fresh_repo
sql 20261117_dated_migration.sql 'create table poker.dated (id bigint);'
commit add-a-dated-name
run_check
expect_rc 1 "a YYYYMMDD name"
want "a dated name: new migrations are numbered" "the dated form is refused"
want "A data fix is not a migration" "and where the thing that wanted a date belongs"

# 12. Rule (b): an unnumbered name is refused, and the message says where it belongs.
fresh_repo
sql fix_stale_rows.sql 'create table poker.unnumbered (id bigint);'
commit add-an-unnumbered-name
run_check
expect_rc 1 "a name with no number at all"
want "not a numbered migration name: a new file here is NNN_<snake_case>.sql" "the required shape is stated"
want "scripts/sql-fixes/" "the data-fix destination is named, though the check does not create it"

# 13. Rule (b): a new file under scripts/sql that is not SQL does not belong here.
fresh_repo
printf '%s\n' 'console.log("not a migration");' >"$repo/$dir/replay_helper.js"
commit add-a-js-file
run_check
expect_rc 1 "a .js file under scripts/sql"
want "$dir/replay_helper.js: it is not a .sql migration" "the non-SQL file is named"

# 14. Rule (c): a file that never says which database it targets.
fresh_repo
printf '%s\n' '-- phase: expand' 'create table poker.no_target (id bigint);' >"$repo/$dir/063_without_db.sql"
commit add-without-db
run_check
expect_rc 1 "a migration with no -- db: line"
want "no \"-- db: <target>\" line in its first 10 lines" "the missing line is named"
want "one satellite database per game" "the reason the target matters is stated"

# 15. Rule (c): a target the operator cannot act on.
fresh_repo
sql_db 063_wrong_target.sql 'production' 'create table poker.wrong_target (id bigint);'
commit add-a-non-target
run_check
expect_rc 1 "a -- db: value that is not a target"
want "\"-- db: production\" is not a target this check knows" "the value is quoted back"

# 16. Rule (c) passing values: a named satellite and every-game beside the writer of case 1.
fresh_repo
sql_db 063_satellite_target.sql 'satellite:pokomon' 'create table poker.sat (id bigint);'
printf '%s\n' '-- db: every-game' '-- phase: expand' 'create table poker.ev (id bigint);' \
    >"$repo/$dir/064_every_game_target.sql"
commit add-with-legitimate-targets
run_check
expect_rc 0 "satellite:<game> and every-game are targets"
want "ok $dir/063_satellite_target.sql: new 063_satellite_target.sql above 062; db: satellite:pokomon" \
    "the satellite target was read out of the header"
want "ok $dir/064_every_game_target.sql: new 064_every_game_target.sql above 062; db: every-game" \
    "so was every-game"

# 17. Rule (c): a file that never says which phase it belongs to.
fresh_repo
printf '%s\n' '-- db: writer' 'create table poker.no_phase (id bigint);' >"$repo/$dir/063_without_phase.sql"
commit add-without-phase
run_check
expect_rc 1 "a migration with no -- phase: line"
want "no \"-- phase: expand\" or \"-- phase: contract\" line in its first 10 lines" "the missing line is named"
want "the code that stopped using it must ship first" "the meaning of the two phases is stated"

# 18. Rule (d): destructive SQL under -- phase: expand.
fresh_repo
sql 063_trunc_under_expand.sql 'truncate poker.seat;'
commit truncate-in-expand
run_check
expect_rc 1 "a truncate that claims to be an expand"
want "line 3 holds a destructive statement (truncate) while the file says \"-- phase: expand\"" \
    "the line, the statement and the promise are all named"

# 19. Rule (d): a contract still needs a reason, and the reason has to be a sentence.
fresh_repo
printf '%s\n' '-- db: writer' '-- phase: contract' 'truncate poker.seat;' \
    >"$repo/$dir/063_trunc_no_reason.sql"
commit truncate-without-a-reason
run_check
expect_rc 1 "a contract with no -- destructive: line"
want "line 3 holds a destructive statement (truncate) and the file carries no \"-- destructive: <reason>\" line" \
    "the missing reason is named"
g rm -q "$dir/063_trunc_no_reason.sql"
printf '%s\n' '-- db: writer' '-- phase: contract' '-- destructive: too short' 'drop table poker.seat;' \
    >"$repo/$dir/063_trunc_short_reason.sql"
commit truncate-with-a-short-reason
run_check
expect_rc 1 "a reason of 9 characters"
want "the \"-- destructive:\" reason is 9 character(s): \"too short\"" "the length found is printed"

# 20. Rule (d) passing: a contract that says what it removes and why; and the word truncate only in prose.
fresh_repo
printf '%s\n' '-- db: writer' '-- phase: contract' \
    '-- destructive: the nightly rebuild recomputes this table, nothing running reads its old rows' \
    'truncate poker.seat;' 'drop index poker.seat_id_ix;' >"$repo/$dir/063_honest_contract.sql"
sql 064_the_word_in_prose.sql '-- we never truncate anything in this file' 'create table poker.prose (id bigint);'
commit contract-with-a-reason
run_check
expect_rc 0 "a contract that says what it removes and why"
want 'is marked destructive ("the nightly rebuild recomputes this table, nothing running reads its old rows")' \
    "the reason is read back"
want "ok $dir/064_the_word_in_prose.sql: new" "a destructive word inside a comment is not a statement"

# 21. Rule (e): a file of data changes only is not a migration.
fresh_repo
sql 063_data_only.sql 'insert into poker.seat (id) values (1);' 'update poker.seat set id = 2;'
commit add-a-data-change
run_check
expect_rc 1 "a file with no DDL"
want "it changes no schema: a migration must carry DDL at line start" "the DDL requirement is stated"
want "is a data change, not a migration" "where the data change belongs instead"

# 22. Rule (e) passing: \gexec driving DDL counts, as it does in 125_migrator_ownership.sql.
fresh_repo
sql 063_generated_ddl.sql "select format('create table poker.g%s (id bigint)', n) from generate_series(1, 3) n;" \
    '\gexec'
commit add-a-gexec-migration
run_check
expect_rc 0 "a migration whose DDL is emitted through gexec"
want '\gexec at line 4' "the gexec driver is what satisfied rule (e)"

# 23. Rule (f): a change that adds a second file on one number raises the collision count.
fresh_repo
sql 063_first_on_063.sql 'create table poker.first (id bigint);'
sql 063_second_on_063.sql 'create table poker.second_on_063 (id bigint);'
commit add-a-collision
run_check
expect_rc 1 "a new number collision"
want "the number 063 is carried by 2 file(s) here and 0 at $baseline, so this change adds a collision (0 -> 1)" \
    "the count before and after is printed"
want "What to do: a merge may not add a duplicate number" "the required move is stated"

# 24. Rule (f) passing: collisions the baseline already carries are inherited, not held against this change.
fresh_repo_colliding
sql 063_above_the_collision.sql 'create table poker.inherited (id bigint);'
commit add-next-to-a-baseline-collision
run_check
expect_rc 0 "a baseline collision this change does not touch"
want "$dir holds 6 numbered file(s) with 1 number collision(s) here" "the inherited collision is the reported state"
unwant "adds a collision" "nothing is blamed for a collision that predates the baseline"

# 25. A range with more than one offender reports every one of them.
fresh_repo
sql 063_one.sql 'truncate poker.seat;'
printf '%s\n' '-- db: writer' 'create table poker.two (id bigint);' >"$repo/$dir/064_two.sql"
commit add-two-offenders
run_check
expect_rc 1 "two offending files"
want "$dir/063_one.sql: line 3 holds a destructive statement (truncate)" "the first is named"
want "$dir/064_two.sql: no \"-- phase: expand\"" "the second is named too"
want "2 changed file(s) in range (2 added, 0 modified, 0 deleted, 0 renamed), 2 checked, 4 finding(s)" \
    "the summary counts the files and the findings"

# 26. A base that is not a commit stops the check rather than silently skipping the diff.
fresh_repo
sql 063_after_bad_base.sql 'create table poker.base (id bigint);'
commit add-063
run_check 1234567890abcdef1234567890abcdef12345678
expect_rc 2 "a --base that does not resolve"
want "is not a commit in this checkout: rules (a) and (f) need the tree at the baseline and at the base" \
    "the reason a shallow or wrong base cannot pass"

# 27. The real checkout: the migration baseline commit passes its own check.
real_root=$(cd "$here/.." && git rev-parse --show-toplevel)
real_baseline=$(sed -n 's/^MIGRATIONS_BASELINE=\([0-9a-f]\{40\}\)$/\1/p' "$here/check-migrations.sh")
rc=0
( cd "$real_root" && bash scripts/check-migrations.sh --base "$real_baseline" ) >"$out" 2>&1 || rc=$?
expect_rc 0 "bash scripts/check-migrations.sh --base <the migration baseline> on this repository"
want "$dir holds " "the real scripts/sql was counted, not skipped"
want "check-migrations: " "the real run says what it did"

echo
echo "check-migrations.test: $pass ok, $fail_count fail"
[ "$fail_count" = 0 ] || exit 1
