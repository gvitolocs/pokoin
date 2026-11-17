#!/usr/bin/env bash
# Run: bash scripts/pre-push-hook.test.sh
# Tests .githooks/pre-push. Throwaway repositories; the hook is called directly, exactly as git calls it: two arguments
# (remote name, remote url) and the ref lines on stdin. The fake `gh` arrives through GH= as in
# scripts/require-ci-green.test.sh and reuses that test's fixtures under scripts/testdata/check-runs/ (derived with jq,
# never copied). The secret-scan cases run real gitleaks and assemble the secret-shaped string at run time, so this
# file scans clean; the throwaway repository carries an untracked copy of the real .gitleaks.toml (untracked, so the
# scanned history stays small and the allowlist itself is never a scanned file).
# Exit 2 when gitleaks is missing: the scan cases cannot be skipped into a pass.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
hook="$root/.githooks/pre-push"
real="$here/testdata/check-runs/main-b757cc1a.json"
t="$(mktemp -d "${TMPDIR:-/tmp}/pre-push-hook-test.XXXXXX")"
trap 'rm -rf "$t"' EXIT

gl="${GITLEAKS:-gitleaks}"
if ! command -v "$gl" > /dev/null 2>&1; then
  if [ -f "$HOME/.local/bin/gitleaks" ] && [ -x "$HOME/.local/bin/gitleaks" ]; then
    gl="$HOME/.local/bin/gitleaks"
  else
    echo "pre-push-hook.test: gitleaks is not installed; the secret-scan cases cannot run" >&2
    exit 2
  fi
fi

fail() {
  echo "FAIL: $*" >&2
  if [ -f "$t/out" ]; then sed 's/^/  | /' "$t/out" >&2; fi
  exit 1
}
ok() { echo "ok: $*"; }
gitq() { git -c user.name=t -c user.email=t@example.invalid "$@"; }

ZERO='0000000000000000000000000000000000000000'
# The url of the repository this guard exists for, in the form a clone has by default.
POKOIN_URL=https://github.com/gvitolocs/pokoin.git
# The refusal the hook owes a red push to main, verbatim (docs/CI.md, "Pushing to main").
MAIN_TEXT='pre-push: main takes only a commit whose required checks are already green on GitHub. Push your branch and open a pull request; merge it there when its checks pass. (An agent never overrides this: stop and report.)'
GOODREASON="owner approved hotfix for checkout"

# ---- fake gh: records that it was called, then applies the gate's own --jq filter to the fixture (real jq) ----
cat > "$t/gh" << 'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_GH_CALLS"
filter=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--jq" ]; then filter="$a"; fi
  prev="$a"
done
jq -r "$filter" "$FAKE_GH_FIXTURE"
FAKE
chmod +x "$t/gh"
: > "$t/gh-calls"

# ---- fixtures: rust-gate is success in the real answer, and the throwaway repo requires only rust-gate ----
jq '.' "$real" > "$t/fx-green.json"
jq '(.check_runs[] | select(.name == "rust-gate") | .conclusion) = "failure"' "$real" > "$t/fx-fail.json"
jq '(.check_runs[] | select(.name == "rust-gate") | .status) = "in_progress"
     | (.check_runs[] | select(.name == "rust-gate") | .conclusion) = null' "$real" > "$t/fx-running.json"
jq '.check_runs = []' "$real" > "$t/fx-none.json"

# ---- throwaway repository ----
repo="$t/repo"
gitq init -q "$repo"
mkdir -p "$repo/scripts"
# The hook runs <top level>/scripts/require-ci-green.sh from the work tree, so it only has to exist there. It stays
# untracked: the gate script is not something the scan cases publish.
cp "$root/scripts/require-ci-green.sh" "$repo/scripts/require-ci-green.sh"
cp "$root/.gitleaks.toml" "$repo/.gitleaks.toml"
printf 'rust-gate\n' > "$repo/scripts/ci-required-checks"
echo x > "$repo/f.txt"
gitq -C "$repo" add f.txt scripts/ci-required-checks
gitq -C "$repo" commit -q -m base
gitq -C "$repo" branch -M main

# main moves BASE -> MAIN1 -> MAIN2; SIDE branches off MAIN1, so pushing SIDE over MAIN2 is a rewrite.
echo one > "$repo/f.txt"
gitq -C "$repo" commit -qam main1
MAIN1="$(gitq -C "$repo" rev-parse HEAD)"
echo two > "$repo/f.txt"
gitq -C "$repo" commit -qam main2
MAIN2="$(gitq -C "$repo" rev-parse HEAD)"
gitq -C "$repo" checkout -q -b rewrite "$MAIN1"
echo rewritten > "$repo/f.txt"
gitq -C "$repo" commit -qam side
SIDE="$(gitq -C "$repo" rev-parse HEAD)"
gitq -C "$repo" checkout -q main
gitq -C "$repo" checkout -q -b feature "$MAIN2"
echo feature > "$repo/g.txt"
gitq -C "$repo" add g.txt
gitq -C "$repo" commit -q -m feature
FEATURE="$(gitq -C "$repo" rev-parse HEAD)"
gitq -C "$repo" checkout -q main

# ---- running the hook ----
EV=()
rc=0
push() { # push <remote name> <remote url> <ref line>... : the hook with EV as its environment, lines on stdin
  local name=$1 url=$2
  shift 2
  : > "$t/gh-calls"
  rm -f "$t/gate.log"
  printf '%s\n' "$@" > "$t/in"
  rc=0
  ( cd "$repo" && env "${EV[@]}" bash "$hook" "$name" "$url" < "$t/in" ) > "$t/out" 2>&1 || rc=$?
}
want_rc() { [ "$rc" = "$1" ] || fail "$2: expected exit $1, got $rc"; }
has() { grep -qF -- "$1" "$t/out" || fail "$2: output lacks '$1'"; }
gh_calls() { wc -l < "$t/gh-calls" | tr -d ' '; }
gh_quiet() { [ ! -s "$t/gh-calls" ] || fail "$1: gh was called ($(gh_calls) time(s)) although it must not be"; }
gh_used() { [ -s "$t/gh-calls" ] || fail "$1: gh was not called"; }

# The CI-gate cases turn the secret scan off (GITLEAKS=/nonexistent with no ~/.local/bin/gitleaks): they test what
# main accepts, and the scan has its own cases below. HOME is an empty directory, which is what makes gitleaks absent.
mkdir -p "$t/nohome"
gate_env=(
  "GITLEAKS=/nonexistent"
  "HOME=$t/nohome"
  "GH=$t/gh"
  "POKOIN_CI_LOG=$t/gate.log"
  "POKOIN_CI_POLL_S=30"
  "POKOIN_CI_WAIT_S=100"
  "POKOIN_CI_MISSING_GRACE_S=1000"
  "FAKE_GH_CALLS=$t/gh-calls"
)
# The scan cases use real gitleaks; nothing here targets main, so the gate is never reached.
scan_env=("GITLEAKS=$gl" "GH=$t/gh" "FAKE_GH_CALLS=$t/gh-calls")

# 1. a branch push to the Pokoin url: allowed, and gh is not called
EV=("${gate_env[@]}" "FAKE_GH_FIXTURE=$t/fx-green.json")
push origin "$POKOIN_URL" "refs/heads/feature $FEATURE refs/heads/feature $ZERO"
want_rc 0 "1 branch push"
gh_quiet "1 branch push"
ok "1: branch push to the Pokoin url -> 0, gh not called"

# 2. a push to main on another url: allowed, gh not called (the default url pattern does not match it)
EV=("${gate_env[@]}" "FAKE_GH_FIXTURE=$t/fx-green.json")
push origin https://github.com/gvitolocs/cardvault.git "refs/heads/main $MAIN2 refs/heads/main $MAIN1"
want_rc 0 "2 main on another url"
gh_quiet "2 main on another url"
ok "2: main on a different repository url -> 0, gh not called"

# 3. main with green checks: allowed, by the gate, with the caller it logs
EV=("${gate_env[@]}" "FAKE_GH_FIXTURE=$t/fx-green.json")
push origin "$POKOIN_URL" "refs/heads/main $MAIN2 refs/heads/main $MAIN1"
want_rc 0 "3 main green"
gh_used "3 main green"
has "rust-gate success (run 134049989018)" "3 main green"
[ -f "$t/gate.log" ] || fail "3 main green: the gate wrote no log"
[ "$(awk -F'\t' '{print $5}' "$t/gate.log" | sort -u | tr '\n' ' ')" = "pre-push " ] \
  || fail "3 main green: the gate did not log pre-push as its caller: $(cat "$t/gate.log")"
ok "3: main whose required checks are green -> 0, gate called with POKOIN_CI_CALLER=pre-push"

# 4. main with a failed check: refused with the push guidance
EV=("${gate_env[@]}" "FAKE_GH_FIXTURE=$t/fx-fail.json")
push origin "$POKOIN_URL" "refs/heads/main $MAIN2 refs/heads/main $MAIN1"
want_rc 1 "4 main red"
has "rust-gate finished as failure" "4 main red"
has "$MAIN_TEXT" "4 main red"
ok "4: main with a failed check -> 1 and the refusal text"

# 5. main with a check still in progress: refused at once, not waited for
s0=$SECONDS
EV=("${gate_env[@]}" "FAKE_GH_FIXTURE=$t/fx-running.json")
push origin "$POKOIN_URL" "refs/heads/main $MAIN2 refs/heads/main $MAIN1"
[ $((SECONDS - s0)) -lt 10 ] || fail "5: the hook waited for a running check"
want_rc 1 "5 main in progress"
has "$MAIN_TEXT" "5 main in progress"
[ "$(gh_calls)" = 1 ] || fail "5: expected 1 gh call, got $(gh_calls)"
ok "5: main with a check in progress -> 1 without waiting"

# 6. main with no check runs at all: refused (a commit that never went through a pull request)
EV=("${gate_env[@]}" "FAKE_GH_FIXTURE=$t/fx-none.json")
push origin "$POKOIN_URL" "refs/heads/main $MAIN2 refs/heads/main $MAIN1"
want_rc 1 "6 main without runs"
has "no rust-gate check run" "6 main without runs"
has "$MAIN_TEXT" "6 main without runs"
ok "6: main with no check runs -> 1"

# 7. deleting main: refused whatever the checks, and without asking GitHub
EV=("${gate_env[@]}" "FAKE_GH_FIXTURE=$t/fx-green.json")
push origin "$POKOIN_URL" "(delete) $ZERO refs/heads/main $MAIN2"
want_rc 1 "7 delete main"
gh_quiet "7 delete main"
has "main is never deleted" "7 delete main"
ok "7: deleting main -> 1"

# 8. a rewrite of main: refused even when the checks of that commit are green
EV=("${gate_env[@]}" "FAKE_GH_FIXTURE=$t/fx-green.json")
push origin "$POKOIN_URL" "refs/heads/main $SIDE refs/heads/main $MAIN2"
want_rc 1 "8 rewrite main"
gh_quiet "8 rewrite main"
has "would not fast-forward" "8 rewrite main"
ok "8: a non-fast-forward push to main -> 1 even with green checks, gh not called"

# 8b. a remote sha this clone does not have is not an ancestor
EV=("${gate_env[@]}" "FAKE_GH_FIXTURE=$t/fx-green.json")
push origin "$POKOIN_URL" "refs/heads/main $MAIN2 refs/heads/main 9999999999999999999999999999999999999999"
want_rc 1 "8b unknown remote sha"
gh_quiet "8b unknown remote sha"
ok "8b: a remote sha unknown locally is treated as not an ancestor -> 1"

# 9. two lines, one branch and one main with red checks: refused
EV=("${gate_env[@]}" "FAKE_GH_FIXTURE=$t/fx-fail.json")
push origin "$POKOIN_URL" \
  "refs/heads/feature $FEATURE refs/heads/feature $ZERO" \
  "refs/heads/main $MAIN2 refs/heads/main $MAIN1"
want_rc 1 "9 two lines"
has "$MAIN_TEXT" "9 two lines"
ok "9: a branch line and a red main line -> 1"

# 10. a lane worker is never given the override, so main stays shut
EV=("${gate_env[@]}" "FAKE_GH_FIXTURE=$t/fx-fail.json" "LANE_WORKER=1" "POKOIN_CI_OVERRIDE=$MAIN2:$GOODREASON")
push origin "$POKOIN_URL" "refs/heads/main $MAIN2 refs/heads/main $MAIN1"
want_rc 1 "10 lane worker override"
gh_quiet "10 lane worker override"
has "lane worker" "10 lane worker override"
has "$MAIN_TEXT" "10 lane worker override"
ok "10: LANE_WORKER=1 plus a correctly formed POKOIN_CI_OVERRIDE -> 1"

# 11. POKOIN_PUSH_GUARD_URL_RE decides which url is this repository
EV=("${gate_env[@]}" "FAKE_GH_FIXTURE=$t/fx-fail.json" "POKOIN_PUSH_GUARD_URL_RE=^/srv/backup/pokoin.git$")
push origin "$POKOIN_URL" "refs/heads/main $MAIN2 refs/heads/main $MAIN1"
want_rc 0 "11 url pattern"
gh_quiet "11 url pattern"
ok "11: a remote url the pattern does not name passes ungated"

# ---- the secret scan, with real gitleaks ----
mk_secret() { # a GitHub-token-shaped string, assembled at run time so this file scans clean
  local s="" i chars=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789
  for i in $(seq 0 35); do s+=${chars:$(((i * 7 + $1) % 62)):1}; done
  printf '%s_%s' ghp "$s"
}
add_file() { # add_file <name> <content>: one committed file, returns its commit in $NEW_COMMIT
  printf 'token = "%s"\n' "$2" > "$repo/$1"
  gitq -C "$repo" add "$1"
  gitq -C "$repo" commit -q -m "add-$1"
  NEW_COMMIT="$(gitq -C "$repo" rev-parse HEAD)"
}

# 12. a branch push whose new commits are clean: allowed, and gitleaks really ran
gitq -C "$repo" checkout -q -b clean-branch "$MAIN2"
echo still clean > "$repo/h.txt"
gitq -C "$repo" add h.txt
gitq -C "$repo" commit -q -m clean
CLEAN="$(gitq -C "$repo" rev-parse HEAD)"
EV=("${scan_env[@]}")
push origin "$POKOIN_URL" "refs/heads/clean-branch $CLEAN refs/heads/clean-branch $MAIN2"
want_rc 0 "12 clean branch"
has "no leaks found" "12 clean branch"
gh_quiet "12 clean branch"
ok "12: a branch push whose new commits are clean -> 0, scanned"

# 13. a secret in one of the new commits: the push is refused
gitq -C "$repo" checkout -q -b secret-branch "$MAIN2"
add_file cfg.txt "$(mk_secret 3)"
gitq -C "$repo" checkout -q main
EV=("${scan_env[@]}")
push origin "$POKOIN_URL" "refs/heads/secret-branch $NEW_COMMIT refs/heads/secret-branch $MAIN2"
want_rc 1 "13 secret in a new commit"
has "push rejected, gitleaks found a secret" "13 secret in a new commit"
has "Do not push and do not widen" "13 secret in a new commit"
ok "13: a branch push with a secret in its new commits -> 1"

# 14. a secret added in one new commit and removed in the next: still in history, still refused
gitq -C "$repo" checkout -q -b addrm-branch "$MAIN2"
add_file gone.txt "$(mk_secret 5)"
ADDED="$NEW_COMMIT"
gitq -C "$repo" rm -q gone.txt
gitq -C "$repo" commit -q -m remove-it
REMOVED="$(gitq -C "$repo" rev-parse HEAD)"
gitq -C "$repo" checkout -q main
EV=("${scan_env[@]}")
push origin "$POKOIN_URL" "refs/heads/addrm-branch $REMOVED refs/heads/addrm-branch $MAIN2"
want_rc 1 "14 added then removed"
has "push rejected, gitleaks found a secret" "14 added then removed"
ok "14: a secret added and removed again inside the pushed range -> 1"

# 15. a brand-new branch (remote sha all zeros): the commits no remote branch has are scanned
gitq -C "$repo" checkout -q -b new-branch "$ADDED"
NEWBR="$(gitq -C "$repo" rev-parse HEAD)"
gitq -C "$repo" checkout -q main
EV=("${scan_env[@]}")
push origin "$POKOIN_URL" "refs/heads/new-branch $NEWBR refs/heads/new-branch $ZERO"
want_rc 1 "15 new branch with a secret"
has "push rejected, gitleaks found a secret" "15 new branch with a secret"
ok "15: a new branch carrying a secret -> 1"

# 16. no gitleaks on this host: one warning line, and the push is allowed
EV=("GITLEAKS=/nonexistent" "HOME=$t/nohome" "GH=$t/gh" "FAKE_GH_CALLS=$t/gh-calls")
push origin "$POKOIN_URL" "refs/heads/clean-branch $CLEAN refs/heads/clean-branch $MAIN2"
want_rc 0 "16 gitleaks missing"
has "was NOT secret-scanned" "16 gitleaks missing"
ok "16: no gitleaks and no ~/.local/bin/gitleaks -> 0 with the warning that it was not scanned"

# 17. a secret pushed to another repository: not ours to scan, and silent about it
EV=("${scan_env[@]}")
push origin https://gitlab.example.invalid/gvitolocs/pokoin.git "refs/heads/addrm-branch $ADDED refs/heads/addrm-branch $MAIN2"
want_rc 0 "17 another url"
if grep -qiE 'gitleaks|scan' "$t/out"; then fail "17 another url: said something about the scan: $(cat "$t/out")"; fi
ok "17: a secret on a remote url that is not this repository -> 0, nothing published here"

# 18. git skips a hook that is not executable, silently, so every tracked file under .githooks/ must be 100755
hooks_not_executable() { git -C "$1" ls-files -s .githooks/ | awk '$1 != "100755" { print $4 }'; }
bad="$(hooks_not_executable "$root")"
[ -z "$bad" ] || fail ".githooks file(s) not mode 100755 in the index: $bad (git skips such a hook silently)"
ok "18: every tracked .githooks file is mode 100755 in the index"
gitq init -q "$t/modes"
mkdir -p "$t/modes/.githooks"
printf '#!/bin/sh\nexit 0\n' > "$t/modes/.githooks/pre-push"
chmod 644 "$t/modes/.githooks/pre-push"
gitq -C "$t/modes" add .githooks/pre-push
[ -n "$(hooks_not_executable "$t/modes")" ] || fail "18b: a 100644 hook was not detected by the check above"
ok "18b: the same check does fail on a 100644 hook"

echo "pre-push-hook.test: all cases passed"
