#!/usr/bin/env bash
# Secret scan for CI (docs/SECRETS.md, "The scan in CI"). Three steps, all run, each printed with its result:
#   a. range scan: gitleaks over every commit of <base>..<head> (a secret added and removed again inside the range is found);
#   b. tree scan: gitleaks over an export of the tracked files of HEAD;
#   c. allowlist guard: fails on ANY change to the allowlist. No trailer, label or variable turns it green.
# Usage: scripts/ci-secret-scan.sh --base <commit> [--head <commit>]
# GITLEAKS picks the binary (default: gitleaks). Exit 0 all passed, 1 a step failed, 2 usage error or gitleaks missing.
set -euo pipefail

tmpdir=
# shellcheck disable=SC2317,SC2329  # called through the trap cleanup EXIT below, never directly
cleanup() {
    if [ -n "$tmpdir" ]; then rm -rf "$tmpdir"; fi
}
trap cleanup EXIT

usage() {
  echo "usage: $0 --base <commit> [--head <commit>]" >&2
  exit 2
}

base=""
head="HEAD"
while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] || usage; base=$2; shift 2 ;;
    --head) [ $# -ge 2 ] || usage; head=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$base" ] || usage

gitleaks=${GITLEAKS:-gitleaks}
if ! command -v "$gitleaks" >/dev/null 2>&1; then
  echo "ci-secret-scan: gitleaks not found ($gitleaks); this is a failure, never a pass" >&2
  exit 2
fi

failed=0

echo "== a. range scan ($base..$head)"
if "$gitleaks" detect --redact --no-banner --log-opts="$base..$head"; then
  echo "range scan: PASS"
else
  echo "range scan: FAIL"
  failed=1
fi

echo "== b. tree scan"
# What is published is HEAD's tracked files, so that is what is scanned: an export of them into a temporary
# directory. The working copy of a development host also holds node_modules/, target/, dist-web/ and whatever an
# agent left untracked there, and scanning those costs minutes and reports files no commit ever carries. A fresh CI
# checkout has nothing but those tracked files, so both hosts answer the same question.
tree_ok=1
if ! tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/ci-secret-scan-tree.XXXXXX" 2> /dev/null)"; then
  echo "  no temporary directory could be created"
  tree_ok=0
elif ! git archive HEAD | tar -x -C "$tmpdir"; then
  echo "  HEAD could not be exported to $tmpdir"
  tree_ok=0
fi
if [ "$tree_ok" -eq 1 ]; then
  # the repository's own policy, from the top of this work tree; without it gitleaks uses its built-in rules, which
  # allowlist nothing and so can only report more, never less
  policy=.gitleaks.toml
  toplevel="$(git rev-parse --show-toplevel 2> /dev/null)" || toplevel=
  if [ -n "$toplevel" ]; then policy="$toplevel/.gitleaks.toml"; fi
  if [ -f "$policy" ]; then
    "$gitleaks" detect --no-git -s "$tmpdir" --redact --no-banner -c "$policy" || tree_ok=0
  else
    "$gitleaks" detect --no-git -s "$tmpdir" --redact --no-banner || tree_ok=0
  fi
fi
if [ -n "$tmpdir" ]; then
  rm -rf "$tmpdir"
  tmpdir=
fi
if [ "$tree_ok" -eq 1 ]; then
  echo "tree scan: PASS"
else
  echo "tree scan: FAIL"
  failed=1
fi

echo "== c. allowlist guard"
guard_ok=1
# The inline marker is assembled here so that this file never contains it literally.
marker="gitleaks"":allow"
if ! git diff --quiet "$base" "$head" -- .gitleaks.toml; then
  echo "  .gitleaks.toml differs between $base and $head"
  guard_ok=0
fi
if [ -e .gitleaksignore ]; then
  echo "  a .gitleaksignore file exists"
  guard_ok=0
fi
if git log -p --no-color --format= "$base..$head" | grep -E '^\+' | grep -vE '^\+\+\+ ' | grep -qF -- "$marker"; then
  echo "  the range adds a line with the inline allow marker"
  guard_ok=0
fi
if [ "$guard_ok" -eq 1 ]; then
  echo "allowlist guard: PASS"
else
  echo "the secret-scan allowlist changed. CI fails on every change to it; only the owner can ship such a commit, with the logged override of scripts/require-ci-green.sh (docs/SECRETS.md)."
  echo "allowlist guard: FAIL"
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  echo "ci-secret-scan: FAILED"
  exit 1
fi
echo "ci-secret-scan: all steps passed"
