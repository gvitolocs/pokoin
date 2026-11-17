#!/usr/bin/env bash
# Tests for scripts/rust-lints-check.sh in throwaway git repositories, each a mini pokoin-rust
# workspace: a virtual root manifest plus crates alpha and beta. No cargo, no network.
# Usage: bash scripts/rust-lints-check.test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/rust-lints-check-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

long_reason='src/lib.rs: the crate really calls unsafe here, for a test'
fails=0
n=0

new_repo() { # new_repo <name>: a workspace with two crates, neither with the table; sets $repo
  n=$((n + 1))
  repo=$tmp/r$n-$1
  mkdir -p "$repo/scripts" "$repo/pokoin-rust"
  git -C "$repo" init -q
  git -C "$repo" config user.email t@example.invalid
  git -C "$repo" config user.name t
  git -C "$repo" config commit.gpgsign false
  # The root manifest is virtual: [workspace] only, so it is not a crate and needs nothing.
  printf '[workspace]\nresolver = "2"\nmembers = ["crates/alpha", "crates/beta"]\n' >"$repo/pokoin-rust/Cargo.toml"
  mk_crate "$repo" alpha 0 0
  mk_crate "$repo" beta 0 0
  commit_all init
}

mk_crate() { # mk_crate <repo> <crate> <forbid-table 0/1> <unsafe-source 0/1>
  local r=$1 c=$2 table=$3 has_unsafe=$4
  local d=$r/pokoin-rust/crates/$c
  mkdir -p "$d/src"
  {
    printf '[package]\nname = "%s"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n' "$c"
    if [ "$table" = 1 ]; then printf '\n[lints.rust]\nunsafe_code = "forbid"\n'; fi
  } >"$d/Cargo.toml"
  if [ "$has_unsafe" = 1 ]; then
    printf 'pub fn touch(p: *const u8) -> u8 {\n    unsafe { *p }\n}\n' >"$d/src/lib.rs"
  else
    printf 'pub fn answer() -> u8 {\n    42\n}\n' >"$d/src/lib.rs"
  fi
}

commit_all() { git -C "$repo" add -A && git -C "$repo" commit -q -m "$1"; }
mark_base() { git -C "$repo" tag -f base >/dev/null; }

set_exceptions() { # set_exceptions <line...>: rewrite the exceptions file, one argument per line
  local f=$repo/scripts/rust-unsafe-exceptions.txt line
  : >"$f"
  for line in "$@"; do printf '%s\n' "$line" >>"$f"; done
}

LAST_OUT=""
run() { # run <expected-exit> <label> [args...]: the check inside $repo
  local want=$1 label=$2 out rc
  shift 2
  set +e
  out=$(cd "$repo" && bash "$root/scripts/rust-lints-check.sh" "$@" 2>&1)
  rc=$?
  set -e
  if [ "$rc" -eq "$want" ]; then
    echo "ok   $label (exit $rc)"
  else
    echo "FAIL $label: expected exit $want, got $rc"
    printf '%s\n' "$out" | sed 's/^/     | /' | tail -15
    fails=$((fails + 1))
  fi
  LAST_OUT=$out
}

says() { # says <text>: the last run printed it
  case $LAST_OUT in
  *"$1"*) echo "ok   message shown: $1" ;;
  *)
    echo "FAIL message missing: $1"
    fails=$((fails + 1))
    ;;
  esac
}

# 1. every crate carries the table, nothing listed.
new_repo all-forbid
mk_crate "$repo" alpha 1 0
mk_crate "$repo" beta 1 0
commit_all both-forbid
run 0 "every crate has the table"

# 2. one crate without it and not listed: named in the failure.
new_repo uncovered
mk_crate "$repo" alpha 1 0
commit_all alpha-forbid
run 1 "a crate without the table and no exception"
says "pokoin-rust/crates/beta: no unsafe_code"

# 3. the key present only in a comment, or under another table.
new_repo wrong-place
{
  printf '[package]\nname = "alpha"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n'
  printf '\n[lints.rust]\n# unsafe_code = "forbid"\n'
} >"$repo/pokoin-rust/crates/alpha/Cargo.toml"
{
  printf '[package]\nname = "beta"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n'
  printf '\n[lints.clippy]\nunsafe_code = "forbid"\n'
} >"$repo/pokoin-rust/crates/beta/Cargo.toml"
commit_all commented-and-other-table
run 1 "the key in a comment or under [lints.clippy]"
says "pokoin-rust/crates/alpha: no unsafe_code"
says "pokoin-rust/crates/beta: no unsafe_code"

# 4. a listed crate with unsafe code and a reason.
new_repo justified
mk_crate "$repo" alpha 1 0
mk_crate "$repo" beta 0 1
set_exceptions "pokoin-rust/crates/beta	$long_reason"
commit_all beta-exception
run 0 "an exception for a crate that uses unsafe"
says "exception: src/lib.rs: the crate really calls unsafe"

# 5. a listed crate that also has the table: stale.
new_repo stale-table
mk_crate "$repo" alpha 1 0
mk_crate "$repo" beta 1 1
set_exceptions "pokoin-rust/crates/beta	$long_reason"
commit_all beta-stale
run 1 "an exception for a crate that has the table"
says "pokoin-rust/crates/beta: it already has unsafe_code"

# 6. a listed crate with no unsafe in its sources: unjustified.
new_repo unjustified
mk_crate "$repo" alpha 1 0
mk_crate "$repo" beta 0 0
set_exceptions "pokoin-rust/crates/beta	$long_reason"
commit_all beta-no-unsafe
run 1 "an exception for a crate with no unsafe code"
says "this crate no longer uses unsafe code: give it the table and remove the exception"

# 7. a listed directory that does not exist.
new_repo missing-dir
mk_crate "$repo" alpha 1 0
mk_crate "$repo" beta 1 0
set_exceptions "pokoin-rust/crates/gamma	$long_reason"
commit_all gamma-gone
run 1 "an exception whose directory does not exist"
says "pokoin-rust/crates/gamma: the directory does not exist"

# 8. a reason shorter than 15 characters.
new_repo short-reason
mk_crate "$repo" alpha 1 0
mk_crate "$repo" beta 0 1
set_exceptions "pokoin-rust/crates/beta	ffi"
commit_all short
run 1 "an exception with a reason too short"
says "an exception needs a reason of at least 15 characters"

# 9. --base: an exception added since the base fails, even when it is justified today.
new_repo added
mk_crate "$repo" alpha 1 0
mk_crate "$repo" beta 0 1
set_exceptions "# no exception yet"
commit_all empty-list
mark_base
set_exceptions "pokoin-rust/crates/beta	$long_reason"
commit_all beta-added
run 1 "an exception added since the base" --base base
says "a new exception to the unsafe-code rule"

# 10. --base where the file did not exist at the base: the change that introduces the list passes.
new_repo new-list
mk_crate "$repo" alpha 1 0
mk_crate "$repo" beta 0 1
commit_all no-list
mark_base
set_exceptions "pokoin-rust/crates/beta	$long_reason"
commit_all first-list
run 0 "the exceptions file introduced since the base" --base base
says "does not exist at"

# 11. an exception removed since the base is always fine.
new_repo removed
mk_crate "$repo" alpha 1 0
mk_crate "$repo" beta 0 1
set_exceptions "pokoin-rust/crates/beta	$long_reason"
commit_all beta-exception
mark_base
mk_crate "$repo" beta 1 0
git -C "$repo" rm -q scripts/rust-unsafe-exceptions.txt
commit_all beta-fixed
run 0 "an exception removed since the base" --base base

# 12. a pure workspace manifest is not a crate: here it is the only manifest left.
new_repo virtual-only
git -C "$repo" rm -qr pokoin-rust/crates/alpha pokoin-rust/crates/beta
commit_all only-the-root
run 0 "a pure workspace manifest needs nothing"
says "rust-lints-check: 0 crate(s)"

# 13. usage errors.
new_repo usage
run 2 "an unknown argument" --nonsense
run 2 "--base without a value" --base

if [ "$fails" -ne 0 ]; then
  echo "rust-lints-check.test: $fails failure(s)"
  exit 1
fi
echo "rust-lints-check.test: all cases passed"
