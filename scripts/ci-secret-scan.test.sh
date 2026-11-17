#!/usr/bin/env bash
# Tests for scripts/ci-secret-scan.sh with real gitleaks, in throwaway git repositories that carry a copy of the real
# .gitleaks.toml. Secret-shaped strings and the inline allow marker are assembled at run time, so this file scans clean.
# Usage: bash scripts/ci-secret-scan.test.sh   (exit 2 when gitleaks is not installed: never a skip that looks like a pass)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
gl=${GITLEAKS:-gitleaks}
if ! command -v "$gl" >/dev/null 2>&1; then
  echo "ci-secret-scan.test: gitleaks is not installed; cannot run" >&2
  exit 2
fi
tmp=$(mktemp -d "${TMPDIR:-/tmp}/ci-secret-scan-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# A GitHub-token-shaped string: "ghp" "_" then 36 characters, built from pieces.
mk_secret() {
  local s="" i chars=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789
  for i in $(seq 0 35); do s+=${chars:$(((i * 7 + $1) % 62)):1}; done
  printf '%s_%s' ghp "$s"
}
marker="gitleaks"":allow"

fails=0
n=0
new_repo() { # new_repo <name>: a repo with the real policy and one clean commit; sets $repo
  n=$((n + 1))
  repo=$tmp/r$n-$1
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email t@example.invalid
  git -C "$repo" config user.name t
  git -C "$repo" config commit.gpgsign false
  cp "$root/.gitleaks.toml" "$repo/.gitleaks.toml"
  echo clean >"$repo/a.txt"
  git -C "$repo" add -A
  git -C "$repo" commit -q -m base
}
commit_all() { git -C "$repo" add -A && git -C "$repo" commit -q -m "$1"; }
run() { # run <expected-exit> <label> [env...]: scan $repo from its commit "base" tag to HEAD
  local want=$1 label=$2 out rc
  shift 2
  set +e
  out=$(cd "$repo" && env "$@" bash "$root/scripts/ci-secret-scan.sh" --base base 2>&1)
  rc=$?
  set -e
  if [ "$rc" -eq "$want" ]; then
    echo "ok   $label (exit $rc)"
  else
    echo "FAIL $label: expected exit $want, got $rc"
    echo "$out" | sed 's/^/     | /' | tail -15
    fails=$((fails + 1))
  fi
  LAST_OUT=$out
}
mark_base() { git -C "$repo" tag -f base >/dev/null; }

# 1. clean range
new_repo clean; mark_base
echo more >>"$repo/a.txt"; commit_all more
run 0 "clean range" GITLEAKS="$gl"

# 2. a commit adds a secret-shaped string
new_repo add; mark_base
printf 'token = "%s"\n' "$(mk_secret 3)" >"$repo/cfg.txt"; commit_all add-secret
run 1 "range adds a secret" GITLEAKS="$gl"

# 3. added in one commit, removed in the next, both inside the range: history scan still finds it
new_repo addrm; mark_base
printf 'token = "%s"\n' "$(mk_secret 5)" >"$repo/cfg.txt"; commit_all add-secret
git -C "$repo" rm -q cfg.txt; commit_all remove-secret
run 1 "added and removed inside the range" GITLEAKS="$gl"

# 4. a secret that exists only before <base>: the range step passes. The tree step (b) is what protects the tree,
#    and the tree no longer holds it. Old history is not this gate's job.
new_repo old
printf 'token = "%s"\n' "$(mk_secret 9)" >"$repo/cfg.txt"; commit_all add-secret
git -C "$repo" rm -q cfg.txt; commit_all remove-secret
mark_base
echo more >>"$repo/a.txt"; commit_all more
run 0 "secret only before base" GITLEAKS="$gl"

# 5. .gitleaks.toml changed inside the range
new_repo toml; mark_base
echo "# a harmless comment" >>"$repo/.gitleaks.toml"; commit_all toml-change
run 1 ".gitleaks.toml changed" GITLEAKS="$gl"
case $LAST_OUT in *"the secret-scan allowlist changed"*) echo "ok   allowlist message shown" ;; *) echo "FAIL allowlist message missing"; fails=$((fails + 1)) ;; esac

# 6. a .gitleaksignore added
new_repo ignore; mark_base
echo "# nothing" >"$repo/.gitleaksignore"; commit_all ignore-file
run 1 ".gitleaksignore added" GITLEAKS="$gl"

# 7. a line with the inline allow marker added
new_repo marker; mark_base
printf 'x = 1 # %s\n' "$marker" >"$repo/b.txt"; commit_all marker
run 1 "inline allow marker added" GITLEAKS="$gl"

# 8. gitleaks missing
new_repo missing; mark_base
run 2 "gitleaks missing" GITLEAKS=/nonexistent

if [ "$fails" -ne 0 ]; then
  echo "ci-secret-scan.test: $fails failure(s)"
  exit 1
fi
echo "ci-secret-scan.test: all cases passed"
