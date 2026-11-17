#!/usr/bin/env bash
# The unsafe-code gate for pokoin-rust (docs/CI.md, "Unsafe code"). Every crate of the Rust
# workspace must carry
#     [lints.rust]
#     unsafe_code = "forbid"
# in its Cargo.toml, so the compiler, not a reviewer, is what keeps unsafe code out. A crate that
# really uses unsafe is listed in scripts/rust-unsafe-exceptions.txt with a reason; the list is
# checked here too, so an exception cannot go stale or hide a crate that no longer needs it.
# Run from anywhere inside the repository.
# Usage: scripts/rust-lints-check.sh [--base <commit>]
# Exit 0 every crate covered, 1 a crate is uncovered or an exception is wrong, 2 a usage error.
set -euo pipefail

usage() {
  echo "usage: $0 [--base <commit>]" >&2
  exit 2
}

base=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] || usage; base=$2; shift 2 ;;
    *) usage ;;
  esac
done

rust_dir=pokoin-rust
exceptions_file=scripts/rust-unsafe-exceptions.txt

if ! toplevel=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "rust-lints-check: run it inside the repository" >&2
  exit 2
fi
cd "$toplevel"

# 0 when the manifest's [lints.rust] table sets unsafe_code to forbid. The key counts only
# between that table header and the next header; a commented-out line does not count.
has_forbid() { # <manifest>
  awk '
    /^[[:space:]]*\[[[:space:]]*lints\.rust[[:space:]]*\]/ { in_lints = 1; next }
    /^[[:space:]]*\[/ { in_lints = 0 }
    in_lints && /^[[:space:]]*unsafe_code[[:space:]]*=/ && $0 ~ /forbid/ { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$1"
}

is_crate_manifest() { # <manifest>: 0 when it declares a package, so it is a crate
  awk '/^[[:space:]]*\[[[:space:]]*package[[:space:]]*\]/ { found = 1 } END { exit(found ? 0 : 1) }' "$1"
}

exception_entries() { # stdin -> one "dir<TAB>reason" line per entry; comments and blanks dropped
  awk '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      tab = index($0, "\t")
      dir = (tab > 0) ? substr($0, 1, tab - 1) : $0
      reason = (tab > 0) ? substr($0, tab + 1) : ""
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", dir)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", reason)
      if (dir != "") printf "%s\t%s\n", dir, reason
    }
  '
}

exception_reason() { # <dir>: print the listed reason, exit 1 when the dir is not listed
  printf '%s\n' "$exceptions" |
    awk -F '\t' -v d="$1" '$1 == d { print substr($0, index($0, "\t") + 1); found = 1 }
          END { exit(found ? 0 : 1) }'
}

crate_uses_unsafe() { # <dir>: 0 when a tracked .rs file of this crate holds the unsafe keyword
  local file
  while IFS= read -r file; do
    case "$file" in *'.rs') return 0 ;; esac
  done < <(git grep -l -w unsafe -- "$1" 2>/dev/null || true)
  return 1
}

exceptions=""
if [ -f "$exceptions_file" ]; then
  exceptions=$(exception_entries <"$exceptions_file")
fi

check_added=0
base_dirs=""
if [ -n "$base" ]; then
  if ! git rev-parse --verify -q "${base}^{commit}" >/dev/null; then
    echo "rust-lints-check: --base $base does not resolve to a commit" >&2
    exit 2
  fi
  if git cat-file -e "$base:$exceptions_file" 2>/dev/null; then
    base_dirs=$(git show "$base:$exceptions_file" | exception_entries | cut -f1)
    check_added=1
  else
    # The change that introduces the list must pass: with no file at the base every line
    # already present counts as inherited, not added.
    echo "rust-lints-check: $exceptions_file does not exist at $base; no exception counts as added here"
  fi
fi

failed=0
n_crates=0
n_forbid=0
n_exception=0
n_uncovered=0

if [ ! -d "$rust_dir" ]; then
  # A renamed or removed workspace would otherwise pass by checking nothing.
  echo "FAIL $rust_dir: no such directory here, so no crate was checked"
  echo "rust-lints-check: 0 crate(s), 0 forbid, 0 exception, 0 uncovered"
  echo "rust-lints-check: FAILED"
  exit 1
fi

while IFS= read -r manifest; do
  [ -n "$manifest" ] || continue
  is_crate_manifest "$manifest" || continue
  dir=${manifest%/*}
  n_crates=$((n_crates + 1))
  if has_forbid "$manifest"; then
    printf '%s\tforbid\n' "$dir"
    n_forbid=$((n_forbid + 1))
    continue
  fi
  if reason=$(exception_reason "$dir"); then
    printf '%s\texception: %s\n' "$dir" "$reason"
    n_exception=$((n_exception + 1))
    continue
  fi
  echo "FAIL $dir: no unsafe_code = \"forbid\" in a [lints.rust] table and no line in $exceptions_file"
  n_uncovered=$((n_uncovered + 1))
  failed=1
done <<<"$(git ls-files -- "$rust_dir" | grep -E '(^|/)Cargo\.toml$' || true)"

# Every listed exception must still be a crate that needs it.
if [ -n "$exceptions" ]; then
  while IFS=$'\t' read -r dir reason; do
    [ -n "$dir" ] || continue
    if [ ! -d "$dir" ]; then
      echo "FAIL exception $dir: the directory does not exist: stale, remove the line"
      failed=1
    elif [ ! -f "$dir/Cargo.toml" ]; then
      echo "FAIL exception $dir: no Cargo.toml, it is not a crate: stale, remove the line"
      failed=1
    elif ! is_crate_manifest "$dir/Cargo.toml"; then
      echo "FAIL exception $dir: its Cargo.toml has no [package] section, it is not a crate: stale, remove the line"
      failed=1
    elif has_forbid "$dir/Cargo.toml"; then
      echo "FAIL exception $dir: it already has unsafe_code = \"forbid\": stale, remove the line"
      failed=1
    elif [ "${#reason}" -lt 15 ]; then
      echo "FAIL exception $dir: an exception needs a reason of at least 15 characters ($exceptions_file is crate directory<TAB>reason)"
      failed=1
    elif ! crate_uses_unsafe "$dir"; then
      echo "FAIL exception $dir: this crate no longer uses unsafe code: give it the table and remove the exception"
      failed=1
    fi
    if [ "$check_added" -eq 1 ] && ! printf '%s\n' "$base_dirs" | grep -qxF -- "$dir"; then
      echo "FAIL exception $dir: a new exception to the unsafe-code rule. CI fails on every added exception; it ships only with the owner's logged override of scripts/require-ci-green.sh"
      failed=1
    fi
  done <<<"$exceptions"
fi

echo "rust-lints-check: $n_crates crate(s), $n_forbid forbid, $n_exception exception, $n_uncovered uncovered"
if [ "$failed" -ne 0 ]; then
  echo "rust-lints-check: FAILED"
  exit 1
fi
echo "rust-lints-check: every crate either forbids unsafe code or is justified in $exceptions_file"
