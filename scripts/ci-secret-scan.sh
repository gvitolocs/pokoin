#!/usr/bin/env bash
# Secret scan for CI (docs/SECRETS.md, "The scan in CI"). Three steps, all run, each printed with its result:
#   a. range scan: gitleaks over every commit of <base>..<head> (a secret added and removed again inside the range is found);
#   b. tree scan: gitleaks over the checked-out tree;
#   c. allowlist guard: fails on ANY change to the allowlist. No trailer, label or variable turns it green.
# Usage: scripts/ci-secret-scan.sh --base <commit> [--head <commit>]
# GITLEAKS picks the binary (default: gitleaks). Exit 0 all passed, 1 a step failed, 2 usage error or gitleaks missing.
set -euo pipefail

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
if "$gitleaks" detect --no-git -s . --redact --no-banner; then
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
