#!/usr/bin/env bash
# A rule check on the schema migration files in scripts/sql and their reverts in scripts/sql-reverts,
# new and changed files only (PK-C005, PK-C019 rule (g)).
# The study it implements is PK-R004 sections 1 and 7(d); the rules a new file must follow are in
# docs/DEPLOY.md ("Writer migrations: the header a new file needs") and docs/CI.md.
#
# scripts/sql has no migrator: a human copies a `docker exec ... psql` line out of docs/DEPLOY.md and
# applies one file by hand, against one of 27 databases (the writer pokoin_marketplace, one satellite per
# game, and others), in whatever order the numbers suggest. PK-R004 counted what that produced: 11 numbers
# used twice or more (15 collisions beyond first use), a renumber after merge (127 -> 129, and the 127 slot
# then re-issued to a different feature), a file added, reverted and re-added, 12 merged migrations edited
# afterwards, 16 files that are not migrations at all (data fixes keyed on literal production ids, sanitizers
# carrying `truncate`), and 44 of 109 files that never say which database they target. Nothing checked any of
# it. A check against the real schema needs a dump of the production schema, which is the owner's step; this
# check reads file names and file headers only — no database, no network, no credential, about five seconds.
#
# The undo work that existed before this was 3 "*.revert.sql" files sitting in scripts/sql beside the
# migrations they belong to: hand-written recoveries with no header, nothing tying one to the file it undoes
# or the database it runs on, and no rule making any other migration carry one. Rules (g) to (i) are that:
# a new migration is undoable or says in its header why it is not, and a revert is a file a rule can read.
#
# Rules. Each finding names the file and says what to do:
#   (a) a file that existed at MIGRATIONS_BASELINE is never modified, deleted or renamed. The exception is a
#       file whose header carries "-- migration: draft" both at the baseline and here: it was never applied,
#       so it may still change. No file carries it today.
#   (b) a new file is named NNN_<snake_case>.sql — three digits, an underscore, [a-z0-9_]+ — and NNN is above
#       every number already in use in the directory at the base and does not reuse one. Dated (YYYYMMDD_) and
#       unnumbered names are refused for new files: the merge order is the apply order, and a dated name hides
#       it. A new file that is not .sql is refused too; a data fix is not a migration and belongs in
#       scripts/sql-fixes/ — a directory this check only names, it does not create.
#   (c) a new file's first 10 lines carry "-- db: <target>", target one of writer, every-game,
#       satellite:<game>, main, and "-- phase: expand" or "-- phase: contract". expand only adds, so it may run
#       before or after the code; contract removes or changes something the previous release used, so the code
#       that stopped using it ships first (the ordering mistake PK-R004 section 6 found in 2085d715).
#   (d) a new file holding a destructive statement — drop table, drop column/constraint, truncate, a
#       delete from without a where, alter ... type, rename — must say "-- phase: contract" and carry
#       "-- destructive: <reason of at least 15 characters>".
#   (e) a new file must contain DDL at line start after -- comments are stripped (create, alter, drop,
#       comment on, grant, revoke, or a \gexec driving them). A file of only insert/update/delete is a data
#       change, not a migration.
#   (f) the whole directory, always: the count of duplicate NNN prefixes at HEAD may not exceed the count at
#       the base. The collisions already on main are the baseline and may only fall.
#   (g) a new numbered migration must be undoable: either the tree at HEAD holds
#       scripts/sql-reverts/NNN_<name>.revert.sql, or the file's first 10 lines carry
#       "-- revert: irreversible: <reason of at least 15 characters>" saying why nothing can put it back.
#   (h) a file added or changed under scripts/sql-reverts/ is NNN_<snake_case>.revert.sql, the name of the
#       migration it undoes; its first 10 lines carry "-- reverts: scripts/sql/NNN_<name>.sql" naming exactly
#       that file, which must exist at HEAD, and a "-- db:" equal to the migration's (any valid target when the
#       migration predates rule (c) and has none — the run then says it could not be compared); it refuses a
#       replica, pg_is_in_recovery() inside a statement that raises, the way the 20261101 artwork revert does;
#       and it carries "-- destructive: <reason of at least 15 characters>" — a revert drops things by
#       definition, so rule (d) does not apply to it while the reason still does. A revert that existed at the
#       base is never edited, renamed or deleted either.
#   (i) nothing else lives in scripts/sql-reverts/: a name not ending in .revert.sql fails.
#   Files under scripts/sql-reverts/ are not migrations: rules (b) and (f) never count them.
#
# Run it from anywhere inside the repository. It reads the committed tree at HEAD, never the working tree.
#
# Usage: scripts/check-migrations.sh [--base <commit>]
#   --base   the pull request's merge base, or the previous commit of the push (default: MIGRATIONS_BASELINE).
#            Rules (b) to (g) run on what `git diff --name-status <base> HEAD -- scripts/sql` reports, rules
#            (h) and (i) on the same range under scripts/sql-reverts.
# Exit: 0 clean, 1 a finding, 2 this check cannot run.
set -euo pipefail

# The state of scripts/sql when this check was written: origin/main at
# c22f9f678f840e777fb1a9b9be3f9b976e067ea7 ("Merge pull request #607 from gvitolocs/pk-c017-hook-env",
# 2026-11-16), whose scripts/sql holds 111 files, 15 number collisions and 12 merged migrations with more
# than one commit. Every file this commit holds may already have been applied to production by hand, so none
# of them may be edited, renamed or removed, and its collisions are rule (f)'s baseline.
# scripts/check-migrations.test.sh points this at its own throwaway baseline through
# POKOIN_MIGRATIONS_BASELINE; the constant itself is never edited by a feature PR.
MIGRATIONS_BASELINE=c22f9f678f840e777fb1a9b9be3f9b976e067ea7

dir=scripts/sql
revert_dir=scripts/sql-reverts
min_reason=15

die() { echo "check-migrations: $*" >&2; exit 2; }
usage() { echo "usage: $0 [--base <commit>]" >&2; exit "${1:-2}"; }

base=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] || usage; base=$2; shift 2 ;;
    -h | --help) usage 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
# Rule (a) is only meaningful against the baseline: without it the check cannot say which file was already
# released, and a silent skip would pass every edited migration. A shallow clone therefore stops here.
# POKOIN_MIGRATIONS_BASELINE replaces the constant rather than topping it up, so the tests in
# scripts/check-migrations.test.sh can point the whole check at their own throwaway baseline.
baseline_ref=${POKOIN_MIGRATIONS_BASELINE:-$MIGRATIONS_BASELINE}
[ -n "$base" ] || base=$baseline_ref

root=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel 2>/dev/null) || die "not inside a git checkout"
cd "$root" || exit 2
head=$(git rev-parse HEAD 2>/dev/null) || die "this checkout has no commit whose tree to read"

for rev in "$base" "$baseline_ref"; do
  git rev-parse --verify --quiet "${rev}^{commit}" >/dev/null \
    || die "$rev is not a commit in this checkout: rules (a) and (f) need the tree at the baseline and at the base, so a shallow clone will not do (git fetch --unshallow); rules (g) to (i) read both trees as well"
done
base=$(git rev-parse "$base")
baseline=$(git rev-parse "$baseline_ref")

findings=0
files_checked=0

fail() { # <file> <message>
  echo "FAIL $1: $2"
  findings=$((findings + 1))
}

existed() { # <rev> <path>: 0 when that tree holds the path
  git cat-file -e "$1:$2" 2>/dev/null
}

# ---- reading one .sql file ---------------------------------------------------------------------------------
analyze_sql() { # stdin: the file -> fact records "<kind>\t<line>\t<value>"
  awk '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    function word(s,   w) { w = s; sub(/[ (;].*$/, "", w); return w }
    function value() { return trim(substr(lo, RSTART + RLENGTH)) }
    function destructive_shape(s) {
      if (s ~ /^drop[ \t]+(table|schema|database)([^a-z0-9_]|$)/) return "drop table"
      if (s ~ /(^|[^a-z0-9_])drop[ \t]+(column|constraint)([^a-z0-9_]|$)/) return "drop column"
      if (s ~ /^truncate([^a-z0-9_]|$)/) return "truncate"
      if (s ~ /^delete[ \t]+from([^a-z0-9_]|$)/ && s !~ /(^|[^a-z0-9_])where([^a-z0-9_]|$)/) return "delete from without a where"
      if (s ~ /^alter([^a-z0-9_]|$)/ && s ~ /(^|[^a-z0-9_])type([^a-z0-9_]|$)/) return "alter ... type"
      if (s ~ /^rename([^a-z0-9_]|$)/) return "rename"
      if (s ~ /^alter([^a-z0-9_]|$)/ && s ~ /(^|[^a-z0-9_])rename([^a-z0-9_]|$)/) return "rename"
      return ""
    }
    {
      lo = tolower($0)
      sub(/\r$/, "", lo)
      # rule (c): the header directives, in the first 10 lines of the file
      if (NR <= 10) {
        if (match(lo, /^[ \t]*--[ \t]*db:[ \t]*/)) printf "db\t%d\t%s\n", NR, value()
        if (match(lo, /^[ \t]*--[ \t]*phase:[ \t]*/)) printf "phase\t%d\t%s\n", NR, value()
        if (match(lo, /^[ \t]*--[ \t]*reverts:[ \t]*/)) printf "reverts\t%d\t%s\n", NR, value()
        if (match(lo, /^[ \t]*--[ \t]*revert:[ \t]*irreversible:[ \t]*/)) printf "irreversible\t%d\t%s\n", NR, value()
        if (lo ~ /^[ \t]*--[ \t]*migration:[ \t]*draft[ \t]*$/) printf "draft\t%d\tyes\n", NR
      }
      # the destructive reason may sit in the header or next to the statement, so it is not a header rule
      if (match(lo, /^[ \t]*--[ \t]*destructive:[ \t]*/)) printf "destructive_reason\t%d\t%s\n", NR, value()
      body = lo
      sub(/--.*/, "", body)
      line[NR] = trim(body)
    }
    END {
      # rule (e): DDL at line start anywhere, including inside a do $$ ... $$ block and as a \gexec driver
      for (i = 1; i <= NR; i++) {
        b = line[i]
        if (b == "") continue
        if (b ~ /^(create|alter|drop|grant|revoke)([^a-z0-9_]|$)/ || b ~ /^comment[ \t]+on([^a-z0-9_]|$)/ || b ~ /^\\gexec([^a-z0-9_]|$)/) {
          printf "ddl\t%d\t%s\n", i, word(b)
          break
        }
      }
      # rule (d) and (h): statements, split at ";" so a multi-line delete from ... where reads correctly and a
      # do $$ ... $$ guard is one statement even when it spans lines
      stmt = ""
      start = 0
      for (i = 1; i <= NR; i++) {
        b = line[i]
        if (b == "") continue
        if (stmt == "") start = i
        stmt = (stmt == "" ? b : stmt " " b)
        if (index(b, ";") > 0 || i == NR) {
          shape = destructive_shape(stmt)
          if (shape != "") printf "destructive\t%d\t%s\n", start, shape
          # rule (h): the replica refusal, a pg_is_in_recovery() test inside a statement that raises
          if (stmt ~ /pg_is_in_recovery[ \t]*\([ \t]*\)/ && stmt ~ /(^|[^a-z0-9_])raise([^a-z0-9_]|$)/) {
            printf "replica_guard\t%d\traise\n", start
          }
          stmt = ""
        }
      }
    }
  '
}

facts_of() { # <rev> <path>: the fact records of that file in that tree
  git show "$1:$2" | analyze_sql
}

has_fact() { # <rev> <path> <kind>: 0 when the file in that tree carries that kind of fact
  existed "$1" "$2" && facts_of "$1" "$2" | awk -F'\t' -v k="$3" '$1 == k { found = 1 } END { exit(found ? 0 : 1) }'
}

fact_value() { # <facts> <kind>: the first value of that kind, empty when the file carries none
  printf '%s\n' "$1" | awk -F'\t' -v k="$2" '$1 == k { print $3; exit }'
}

fact_line() { # <facts> <kind>: the line the first fact of that kind sits on
  printf '%s\n' "$1" | awk -F'\t' -v k="$2" '$1 == k { print $2; exit }'
}

fact_values() { # <facts> <kind>: every value of that kind, one per line
  printf '%s\n' "$1" | awk -F'\t' -v k="$2" '$1 == k { print $3 }'
}

# The "-- db:" targets a migration or a revert may name, shared by rule (c) and rule (h).
db_value_ok() { # <target>: 0 when this check knows that target
  case "$1" in
    writer | every-game | main) ;;
    satellite:?*) printf '%s\n' "${1#satellite:}" | grep -qE '^[a-z0-9_]+$' ;;
    *) return 1 ;;
  esac
}

# ---- the NNN number space ----------------------------------------------------------------------------------
# Only the three-digit scheme is counted: the dated YYYYMMDD_ files are a different scheme and rule (b)
# refuses them for a new file, so they neither set the maximum nor add a collision here.
numbers_at() { # <rev>: every NNN prefix in $dir at that tree, one per line, duplicates kept
  git ls-tree -r --name-only "$1" -- "$dir" | awk -F/ '{ print $NF }' |
    awk '/^[0-9][0-9][0-9]_/ { print substr($0, 1, 3) }'
}

number_stat() { # <rev>: "<files> <collisions>" of the numbered files at that tree
  numbers_at "$1" | awk '{ n[$1]++; t++ } END { d = 0; for (k in n) d++; print t + 0, t + 0 - d }'
}

highest_at() { # <rev>: the highest NNN in use at that tree, 0 when there is none
  local highest
  highest=$(numbers_at "$1" | sort -n | tail -1)
  printf '%s\n' "${highest:-0}"
}

users_of() { # <rev> <NNN>: the paths at that tree carrying that number
  git ls-tree -r --name-only "$1" -- "$dir" |
    awk -F/ -v n="$2" '$NF ~ ("^" n "_") { printf "%s%s", sep, $0; sep = ", " } END { print "" }'
}

next_free_hint() { # <rev>: what to call the new file
  local highest
  highest=$(highest_at "$1")
  if [ "$((10#$highest))" -ge 999 ]; then
    printf 'the three-digit number space is full: stop and raise it with the owner before adding a migration'
  else
    printf 'name it %03d_<snake_case>.sql' "$((10#$highest + 1))"
  fi
}

# ---- rule (f): the whole directory, at the base and here -----------------------------------------------------
read -r base_files base_collisions <<<"$(number_stat "$base")"
read -r head_files head_collisions <<<"$(number_stat "$head")"
head_reverts=$(git ls-tree -r --name-only "$head" -- "$revert_dir" | grep -c . || true)
if [ "$head_collisions" -gt "$base_collisions" ]; then
  while read -r num from to; do
    [ -n "$num" ] || continue
    fail "$dir" "the number $num is carried by $to file(s) here and $from at $base, so this change adds a collision ($base_collisions -> $head_collisions). The files: $(users_of "$head" "$num")"
    fail "$dir" "What to do: a merge may not add a duplicate number — the $base_collisions collision(s) on main are the baseline and may only fall. $(next_free_hint "$base"), and never edit, rename or remove a migration already on main to make room."
  done < <(
    {
      numbers_at "$base" | awk '{ print "b " $1 }'
      numbers_at "$head" | awk '{ print "h " $1 }'
    } | awk '$1 == "b" { b[$2]++; next } { h[$2]++ } END { for (k in h) if (h[k] > b[k] + 0) print k, b[k] + 0, h[k] }' | sort -n
  )
fi

# ---- the files in the range ----------------------------------------------------------------------------------
db_hint='What to do: add a "-- db: writer", "-- db: every-game", "-- db: satellite:<game>" or "-- db: main" line to the first 10 lines. This directory feeds the writer and one satellite database per game, 27 in all, and a file that never says which one it targets is applied by whoever remembers: on the wrong database it either creates an orphan table or succeeds doing nothing.'
phase_hint='What to do: add "-- phase: expand" (the file only adds, so it may run before or after the code) or "-- phase: contract" (it removes or changes something the previous release used, so the code that stopped using it must ship first) to the first 10 lines.'
revert_hint='What to do: write the undo as scripts/sql-reverts/<the number>_<the name>.revert.sql, the same number and name as this file — there is no migrator and no down command, so that file is the only record of what to put back, and it is written while the person applying the migration still knows. When the migration really cannot be undone (it overwrites rows it did not copy, or drops something the previous release still reads), say so in a "-- revert: irreversible: <why>" line in the first 10 lines instead: an honest "this one is a ratchet" is worth more than a revert file that would not run.'

check_file() { # <path> <new>: rules (c), (d), (e) and (g), plus (b) when <new> is 1
  local path=$1 is_new=$2
  local name num highest facts db_values db_bad='' phase_values v dest dest_line dest_shape reason reason_len
  local ddl_line ddl_word found=0 revert_path irreversible

  files_checked=$((files_checked + 1))

  if [ "${path##*.}" != 'sql' ]; then
    fail "$path" "it is not a .sql migration, and only numbered .sql migrations live in $dir. What to do: a data fix, a sanitizer or a test script is not a migration — it goes to scripts/sql-fixes/ (which this check does not create) or to scripts/ beside the tool that runs it."
    return 1
  fi

  if ! facts=$(facts_of "$head" "$path"); then
    fail "$path" "it is not readable in the tree at HEAD, so nothing of it could be checked"
    return 1
  fi

  name=${path##*/}
  highest=$(highest_at "$base")
  if [ "$is_new" = 1 ]; then
    if [[ $name =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]]; then
      num=${name:0:3}
      if [ -n "$(numbers_at "$base" | grep -x "$num" || true)" ]; then
        fail "$path" "the number $num is already used at $base by $(users_of "$base" "$num"). A new file may not reuse a number: the number is how the operator picks the file to apply, and two files with one number are applied in whichever order the shell expands them. What to do: $(next_free_hint "$base") instead."
        found=1
      elif [ "$((10#$num))" -le "$((10#$highest))" ]; then
        fail "$path" "the number $num is not above $highest, the highest number in $dir at $base. Gaps are not free: PK-R004 section 1 found 15 of them, and each belongs to a file in cardvault's oracle-postgres/schema, the same number space. What to do: $(next_free_hint "$base"); after it merges, the number is frozen."
        found=1
      fi
    elif [[ $name =~ ^[0-9]{8}_ ]]; then
      fail "$path" "a dated name: new migrations are numbered, three digits above the highest in use here. What to do: $(next_free_hint "$base"). A YYYYMMDD name carries no apply order, and 10 of these files already had to be replayed in name order to be applied at all. A data fix is not a migration: it goes to scripts/sql-fixes/ (not a migration directory)."
      found=1
    else
      fail "$path" "not a numbered migration name: a new file here is NNN_<snake_case>.sql — three digits, an underscore, then [a-z0-9_]+. What to do: $(next_free_hint "$base"). An unnumbered name is a data fix, and a data fix is not a migration: scripts/sql-fixes/ (not a migration directory) or scripts/ is where it belongs."
      found=1
    fi
  fi

  # rule (g): nothing goes onto one of 27 databases by hand without a way back, or a written reason there is none
  if [ "$is_new" = 1 ] && [[ $name =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]]; then
    revert_path=$revert_dir/${name%.sql}.revert.sql
    if existed "$head" "$revert_path"; then
      :
    else
      irreversible=$(fact_value "$facts" irreversible)
      if [ -z "$irreversible" ]; then
        fail "$path" "nothing undoes it: a new migration needs its revert in $revert_path, or the line \"-- revert: irreversible: <why>\" in its header. $revert_hint"
        found=1
      elif [ "${#irreversible}" -lt "$min_reason" ]; then
        fail "$path" "the \"-- revert: irreversible:\" reason is ${#irreversible} character(s): \"$irreversible\", and there is no $revert_path. It must be at least $min_reason characters and must say what the migration destroys that no file can put back; a new migration needs its revert in $revert_path, or the line \"-- revert: irreversible: <why>\" in its header. $revert_hint"
        found=1
      fi
    fi
  fi

  db_values=$(fact_values "$facts" db)
  phase_values=$(fact_values "$facts" phase)

  if [ -z "$db_values" ]; then
    fail "$path" "no \"-- db: <target>\" line in its first 10 lines. $db_hint"
    found=1
  else
    while IFS= read -r v; do
      [ -n "$v" ] || continue
      db_value_ok "$v" || db_bad="$db_bad $v"
    done <<<"$db_values"
    for v in $db_bad; do
      fail "$path" "\"-- db: $v\" is not a target this check knows. $db_hint"
      found=1
    done
  fi

  if [ -z "$phase_values" ]; then
    fail "$path" "no \"-- phase: expand\" or \"-- phase: contract\" line in its first 10 lines. $phase_hint"
    found=1
  else
    while IFS= read -r v; do
      [ -n "$v" ] || continue
      case "$v" in
        expand | contract) ;;
        *)
          fail "$path" "\"-- phase: $v\" is neither expand nor contract. $phase_hint"
          found=1
          ;;
      esac
    done <<<"$phase_values"
  fi

  dest=$(printf '%s\n' "$facts" | awk -F'\t' '$1 == "destructive" { print $2 "\t" $3; exit }')
  if [ -n "$dest" ]; then
    dest_line=${dest%%$'\t'*}
    dest_shape=${dest#*$'\t'}
    if printf '%s\n' "$phase_values" | grep -qx contract; then :; else
      if printf '%s\n' "$phase_values" | grep -qx expand; then
        fail "$path" "line $dest_line holds a destructive statement ($dest_shape) while the file says \"-- phase: expand\", which promises that the previous release still runs against this schema. What to do: mark it \"-- phase: contract\" and ship the code that stops using the dropped thing first, or take the statement out."
      else
        fail "$path" "line $dest_line holds a destructive statement ($dest_shape), which is a contract: it removes or changes something the previous release used. $phase_hint"
      fi
      found=1
    fi
    reason=$(fact_value "$facts" destructive_reason)
    reason_len=${#reason}
    if [ -z "$reason" ]; then
      fail "$path" "line $dest_line holds a destructive statement ($dest_shape) and the file carries no \"-- destructive: <reason>\" line. What to do: add one, saying what the statement removes and why nothing that is still running needs it — at least $min_reason characters, because that line is the whole record of why the contract is safe to ship."
      found=1
    elif [ "$reason_len" -lt "$min_reason" ]; then
      fail "$path" "the \"-- destructive:\" reason is $reason_len character(s): \"$reason\". It must be at least $min_reason, and it must say what the statement removes and why nothing that is still running needs it."
      found=1
    fi
  fi

  ddl_line=$(fact_line "$facts" ddl)
  ddl_word=$(fact_value "$facts" ddl)
  if [ -z "$ddl_line" ]; then
    fail "$path" "it changes no schema: a migration must carry DDL at line start (create, alter, drop, comment on, grant, revoke, or a \\gexec driving them) and this file has none. A file of only insert/update/delete is a data change, not a migration: what to do is move it to scripts/sql-fixes/ (not a migration directory) and run it by hand, or add here the schema change the data depends on."
    found=1
  fi

  if [ "$found" = 0 ]; then
    printf 'ok %s: %s; db: %s; phase: %s; %s at line %s%s%s\n' "$path" \
      "$(if [ "$is_new" = 1 ]; then printf 'new %s above %s' "$name" "$highest"; else printf 'changed in range'; fi)" \
      "$(printf '%s\n' "$db_values" | paste -sd, -)" \
      "$(printf '%s\n' "$phase_values" | paste -sd, -)" \
      "$ddl_word" "$ddl_line" \
      "$(if [ -n "$dest" ]; then printf '; %s at line %s is marked destructive (\"%s\")' "$dest_shape" "$dest_line" "$reason"; fi)" \
      "$(if [ -n "$revert_path" ] && existed "$head" "$revert_path"; then printf '; its revert is %s' "$revert_path";
         elif [ -n "$irreversible" ]; then printf '; marked irreversible (\"%s\")' "$irreversible"; fi)"
    return 0
  fi
  return 1
}

# ---- rules (h) and (i): a file under scripts/sql-reverts -----------------------------------------------------
reverts_hint='What to do: add a "-- reverts: scripts/sql/<NNN>_<name>.sql" line to the first 10 lines, naming the migration this file undoes. A revert is read in the middle of an incident, out of a directory of hand-written files: that line and the file name are the only things tying it to a migration and to the reason it exists.'
rdb_hint='What to do: copy the migration'"'"'s "-- db: <target>" line into the first 10 lines of the revert. Run against another database a revert either stops on the first missing object or, worse, finds a same-named table there and drops it.'
guard_hint='What to do: put the guard the 20261101 artwork revert carries at the top, ahead of anything that changes data: "do $$ begin if pg_is_in_recovery() then raise exception '"'"'refusing to run on a replica'"'"'; end if; end $$;" The Pi replica is one psql line away from the writer and a revert is run in a hurry: without the raise, every statement fails with "cannot execute ... in a read-only transaction" and the operator cannot tell a replica from a migration that has already been undone.'

check_revert_file() { # <path> <new>: rules (h) and (i) on one file under $revert_dir
  local path=$1 is_new=$2
  local name stem mig mig_facts mig_dbs facts reverts rdb_values v db_note='' guard reason reason_len found=0

  files_checked=$((files_checked + 1))
  name=${path##*/}

  if [[ $name != *.revert.sql ]]; then
    fail "$path" "only <NNN>_<name>.revert.sql files live in $revert_dir, and \"$name\" does not end in .revert.sql. What to do: a note about a migration belongs in docs/ next to the section that explains it, a data fix beside the tool that runs it, and a revert gets the number and name of the migration it undoes."
    return 1
  fi
  if ! [[ $name =~ ^[0-9]{3}_[a-z0-9_]+\.revert\.sql$ ]]; then
    fail "$path" "not a revert name: a file in $revert_dir is NNN_<snake_case>.revert.sql — three digits, an underscore, [a-z0-9_]+, then \".revert.sql\". What to do: name it after the migration it undoes, digit for digit; the operator walks from a migration to its revert by that name and no other."
    return 1
  fi
  if ! facts=$(facts_of "$head" "$path"); then
    fail "$path" "it is not readable in the tree at HEAD, so nothing of it could be checked"
    return 1
  fi

  stem=${name%.revert.sql}
  mig=$dir/$stem.sql

  reverts=$(fact_value "$facts" reverts)
  if [ -z "$reverts" ]; then
    fail "$path" "no \"-- reverts: $mig\" line in its first 10 lines. $reverts_hint"
    found=1
  elif [ "$reverts" != "$mig" ]; then
    fail "$path" "its \"-- reverts: $reverts\" line names another migration than its own file name, which promises $mig. What to do: rename the file after the migration it really undoes, or point the line at that file — one of the two is wrong and the file itself cannot say which."
    found=1
  elif ! existed "$head" "$reverts"; then
    fail "$path" "it reverts $reverts, which is not in the tree at HEAD. What to do: put the migration back, or take this file out. A revert whose migration nobody has is applied by whoever finds it, and every statement in it drops or overwrites objects nothing in this repository created."
    found=1
  fi

  rdb_values=$(fact_values "$facts" db)
  if [ -z "$rdb_values" ]; then
    fail "$path" "no \"-- db: <target>\" line in its first 10 lines. $rdb_hint"
    found=1
  else
    while IFS= read -r v; do
      [ -n "$v" ] || continue
      db_value_ok "$v" || {
        fail "$path" "\"-- db: $v\" is not a target this check knows. $rdb_hint"
        found=1
      }
    done <<<"$rdb_values"
  fi

  # rule (h): the revert runs on the database its migration ran on. A baseline migration names none.
  if existed "$head" "$mig" && [ -n "$rdb_values" ]; then
    mig_facts=$(facts_of "$head" "$mig")
    mig_dbs=$(fact_values "$mig_facts" db)
    if [ -z "$mig_dbs" ]; then
      db_note="; its \"-- db:\" could not be compared: $mig predates the header rule and carries no \"-- db:\" line, so check by hand that the revert runs on the database the migration ran on"
    else
      while IFS= read -r v; do
        [ -n "$v" ] || continue
        printf '%s\n' "$mig_dbs" | grep -qxF -- "$v" || {
          fail "$path" "its \"-- db: $v\" is not the \"-- db: $(printf '%s\n' "$mig_dbs" | paste -sd, -)\" of $mig, the migration it reverts. $rdb_hint"
          found=1
        }
      done <<<"$rdb_values"
    fi
  fi

  guard=$(fact_line "$facts" replica_guard)
  if [ -z "$guard" ]; then
    fail "$path" "no statement raises on pg_is_in_recovery(), so nothing stops this file from being run against the Pi replica. $guard_hint"
    found=1
  fi

  reason=$(fact_value "$facts" destructive_reason)
  reason_len=${#reason}
  if [ -z "$reason" ]; then
    fail "$path" "no \"-- destructive: <reason>\" line. Rule (d) does not apply to a revert — dropping is what a revert does — but the reason line still does: it is the record of what this file destroys and why that is safe. What to do: add one of at least $min_reason characters."
    found=1
  elif [ "$reason_len" -lt "$min_reason" ]; then
    fail "$path" "the \"-- destructive:\" reason is $reason_len character(s): \"$reason\". It must be at least $min_reason, and it must say what the revert drops and why nothing that is still running needs what the migration built."
    found=1
  fi

  if [ "$found" = 0 ]; then
    printf 'ok %s: %s of %s; db: %s; replica refusal at line %s; destructive (\"%s\")%s\n' "$path" \
      "$(if [ "$is_new" = 1 ]; then printf 'new revert'; else printf 'revert changed in range'; fi)" \
      "$mig" "$(printf '%s\n' "$rdb_values" | paste -sd, -)" "$guard" "$reason" "$db_note"
    return 0
  fi
  return 1
}

changed=0
n_added=0
n_modified=0
n_deleted=0
n_renamed=0

handle_sql_change() { # <status> <path> [<path2>]: rules (a) to (g) on one scripts/sql change
  local kind=$1 p1=$2 p2=${3:-}
  case "$kind" in
    D)
      n_deleted=$((n_deleted + 1))
      if existed "$baseline" "$p1"; then
        fail "$p1" "it is in $dir at the migration baseline $baseline and is deleted here. A migration on main is never edited, renamed or removed: add a new file. What to do: put the file back and, if the object must go, drop it in a new numbered migration marked \"-- phase: contract\" and \"-- destructive: <reason>\"."
      else
        printf 'ok %s: deleted in range and not in scripts/sql at the baseline, so it was never released: removing it is fine\n' "$p1"
        files_checked=$((files_checked + 1))
      fi
      ;;
    M | T)
      n_modified=$((n_modified + 1))
      if existed "$baseline" "$p1"; then
        if has_fact "$baseline" "$p1" draft && has_fact "$head" "$p1" draft; then
          printf 'ok %s: modified, and it carried "-- migration: draft" at the baseline as well as here, so it was never applied and may still change\n' "$p1"
          files_checked=$((files_checked + 1))
        else
          fail "$p1" "it is in $dir at the migration baseline $baseline and has been modified. A migration on main is never edited, renamed or removed: add a new file. What to do: git checkout $base -- $p1, then put the change in a new numbered migration; the 12 merged migrations PK-R004 section 1 found edited after the fact are the history this rule stops. Only a file whose header carried \"-- migration: draft\" at the baseline may still be edited, because it has not been applied."
        fi
      else
        check_file "$p1" 0 || true
      fi
      ;;
    R | C)
      n_renamed=$((n_renamed + 1))
      if existed "$baseline" "$p1"; then
        if has_fact "$baseline" "$p1" draft && has_fact "$head" "$p2" draft; then
          printf 'ok %s: renamed to %s while carrying "-- migration: draft" at the baseline too, so it was never applied\n' "$p1" "$p2"
          files_checked=$((files_checked + 1))
        else
          fail "$p1" "it is in $dir at the migration baseline $baseline and has been renamed, to $p2. A migration on main is never edited, renamed or removed: add a new file. What to do: undo the rename. The 127 -> 129 renumber of PK-R004 section 1 is what this refuses: the released file is the name production was applied under, and re-issuing 127 to a second feature made one number mean two things."
        fi
      else
        check_file "$p2" 1 || true
      fi
      ;;
    A)
      n_added=$((n_added + 1))
      check_file "$p1" 1 || true
      ;;
    *) die "git diff reported status '$kind' for $p1: this check does not know how to read it" ;;
  esac
}

handle_revert_change() { # <status> <path> [<path2>]: rules (h) and (i) on one scripts/sql-reverts change
  local kind=$1 p1=$2 p2=${3:-}
  # Unlike rule (a), which asks whether the baseline released the file, this asks only whether the base holds it:
  # a revert is written once, in the same change as the migration it undoes, so being in the base at all means it
  # is on main, and what was applied to production is not something a later pull request may rewrite.
  case "$kind" in
    D)
      n_deleted=$((n_deleted + 1))
      if existed "$base" "$p1"; then
        fail "$p1" "it is in $revert_dir at $base and is deleted here. A revert on main is never edited: add a corrected one with a new note in docs, or a new migration. What to do: git checkout $base -- $p1; if this revert is wrong, say so in docs and land a corrected revert next to it, because the file that was applied in the incident is the record of what actually ran."
      else
        printf 'ok %s: deleted in range and not in %s at the base, so it was never merged: removing it is fine\n' "$p1" "$revert_dir"
        files_checked=$((files_checked + 1))
      fi
      ;;
    M | T)
      n_modified=$((n_modified + 1))
      if existed "$base" "$p1"; then
        fail "$p1" "it is in $revert_dir at $base and has been modified. A revert on main is never edited: add a corrected one with a new note in docs, or a new migration. What to do: git checkout $base -- $p1, then put the correction in a new file — the same rule that stops an edited migration stops an edited revert, because the operator may have run the first one already."
      else
        check_revert_file "$p1" 0 || true
      fi
      ;;
    R | C)
      n_renamed=$((n_renamed + 1))
      if existed "$base" "$p1"; then
        fail "$p1" "it is in $revert_dir at $base and has been renamed, to $p2. A revert on main is never edited: add a corrected one with a new note in docs, or a new migration. What to do: undo the rename; a revert is found by the number and name of its migration, so renaming one loses the way back."
      else
        check_revert_file "$p2" 1 || true
      fi
      ;;
    A)
      n_added=$((n_added + 1))
      check_revert_file "$p1" 1 || true
      ;;
    *) die "git diff reported status '$kind' for $p1: this check does not know how to read it" ;;
  esac
}

each_change() { # <dir> <handler>: every base..HEAD change under <dir>, as <handler> <status> <path> [<path2>]
  local d=$1 handler=$2 st kind p1 p2
  while IFS= read -r -d '' st; do
    kind=${st%%[0-9]*}
    IFS= read -r -d '' p1 || die "git diff reported status $st with no path"
    p2=''
    case "$kind" in
      R | C) IFS= read -r -d '' p2 || die "git diff reported $st for $p1 with no second path" ;;
    esac
    changed=$((changed + 1))
    "$handler" "$kind" "$p1" "$p2"
  done < <(git diff --name-status -z -M "$base" "$head" -- "$d")
}

each_change "$dir" handle_sql_change
each_change "$revert_dir" handle_revert_change

echo "check-migrations: $dir holds $head_files numbered file(s) with $head_collisions number collision(s) here and $revert_dir holds $head_reverts revert(s); $base had $base_files and $base_collisions: the collisions already on main are the baseline, and rule (f) lets that number only fall"

if [ "$changed" = 0 ]; then
  if [ "$findings" -gt 0 ]; then
    echo "check-migrations: FAILED, $findings finding(s)"
    exit 1
  fi
  echo "check-migrations: nothing changed under $dir between $base and HEAD, so there is no new or edited migration to check; nothing changed under $revert_dir either; the directory rules above still ran"
  exit 0
fi

if [ "$findings" -gt 0 ]; then
  echo "check-migrations: $changed changed file(s) in range ($n_added added, $n_modified modified, $n_deleted deleted, $n_renamed renamed), $files_checked checked, $findings finding(s): FAILED"
  exit 1
fi
echo "check-migrations: $changed changed file(s) in range ($n_added added, $n_modified modified, $n_deleted deleted, $n_renamed renamed): every one is a numbered migration that says what it changes, on which database and in which phase, and every revert in $revert_dir names its migration, repeats its database and refuses a replica"
