#!/usr/bin/env bash
# Refuse to ship a commit unless every required GitHub check run is green on it. docs/CI.md, "Deploy gate".
#
#   scripts/require-ci-green.sh [--repo-dir DIR] [--no-wait] [--caller-script PATH] [--self-check-only] <commit>
#
# Exit 0: this checkout's own gate and deploy scripts are byte-identical to origin/main's, and every check named
# in scripts/ci-required-checks (as committed in <commit>) is a green GitHub Actions check run on <commit>, or
# the owner's override was given. Exit 1: refused. Exit 2: usage error.
# Any doubt is a refusal: an API error, an answer that does not parse, a missing run, a missing list, a script
# this checkout changed.
#
# --caller-script <path> (repeatable) names the script that is calling the gate, so its own bytes are compared
# with origin/main too. --self-check-only does that comparison and nothing else: exit 0 when every compared file
# is origin/main's, 1 when one is not (no GitHub call, no log line, no commit needed).
#
# Environment (all optional):
#   GH                          the gh binary (default: gh on PATH, else $HOME/.local/bin/gh)
#   POKOIN_CI_REPO              GitHub repository (default: gvitolocs/pokoin)
#   POKOIN_CI_POLL_S            seconds between polls (default 30)
#   POKOIN_CI_WAIT_S            give up after this many seconds (default 3600)
#   POKOIN_CI_API_RETRIES       refuse after this many unreadable GitHub answers in a row (default 5)
#   POKOIN_CI_MISSING_GRACE_S   how long a check run may be absent before it is a refusal (default 300)
#   POKOIN_CI_LOG               log file (default: $HOME/pokoin-deploy/ci-gate.log)
#   POKOIN_CI_CALLER            who is calling, for the log (default: unknown)
#   POKOIN_CI_OVERRIDE          the owner's emergency switch: <full 40-hex commit id>:<reason>
#   POKOIN_OPS_RECORD_CMD       command that takes one JSON object on stdin (default: lucina-rs ops record)
set -euo pipefail

# git exports GIT_DIR (and GIT_PREFIX, GIT_EXEC_PATH, GIT_CONFIG_PARAMETERS) into the hooks it runs; with GIT_DIR
# set and no GIT_WORK_TREE, git takes the current directory as the top of the work tree, so a relative
# `rev-parse --show-toplevel` answers the directory the gate happens to sit in. Drop them: the gate always names
# the repository it means with -C / --repo-dir and never needs the caller's hook environment.
unset GIT_DIR GIT_WORK_TREE GIT_PREFIX GIT_INDEX_FILE GIT_COMMON_DIR

BEFORE_SHA_PREFIX="require-ci-green"
OVERRIDE_NOTE="POKOIN_CI_OVERRIDE is the owner's emergency switch: it needs the exact commit id and a reason, and every use is written to the log and to the ops record. An agent never sets it (worker environments do not pass it): if you are an agent, stop and report."

usage() {
  echo "usage: require-ci-green.sh [--repo-dir DIR] [--no-wait] [--caller-script PATH] [--self-check-only] [<commit>]" >&2
  exit 2
}

repo_dir=.
no_wait=0
self_check_only=0
commit_arg=
caller_scripts=()
while [ $# -gt 0 ]; do
  case "$1" in
    --repo-dir)
      [ $# -ge 2 ] || usage
      repo_dir="$2"
      shift 2
      ;;
    --caller-script)
      [ $# -ge 2 ] || usage
      caller_scripts+=("$2")
      shift 2
      ;;
    --self-check-only)
      self_check_only=1
      shift
      ;;
    --no-wait)
      no_wait=1
      shift
      ;;
    -h | --help) usage ;;
    -*) usage ;;
    *)
      [ -z "$commit_arg" ] || usage
      commit_arg="$1"
      shift
      ;;
  esac
done

# --self-check-only compares files with origin/main and needs no commit; every other mode ships one.
if [ "$self_check_only" = 1 ] && [ -z "$commit_arg" ]; then
  SHA=
  SHORT=-
else
  [ -n "$commit_arg" ] || usage
  SHA="$(git -C "$repo_dir" rev-parse --verify "${commit_arg}^{commit}" 2> /dev/null)" || {
    echo "$BEFORE_SHA_PREFIX: cannot resolve '$commit_arg' to a commit in $repo_dir" >&2
    exit 2
  }
  SHORT="${SHA:0:12}"
fi

GH_BIN="${GH:-}"
REPO="${POKOIN_CI_REPO:-gvitolocs/pokoin}"
POLL_S="${POKOIN_CI_POLL_S:-30}"
WAIT_S="${POKOIN_CI_WAIT_S:-3600}"
API_RETRIES="${POKOIN_CI_API_RETRIES:-5}"
GRACE_S="${POKOIN_CI_MISSING_GRACE_S:-300}"
LOG="${POKOIN_CI_LOG:-$HOME/pokoin-deploy/ci-gate.log}"
CALLER="${POKOIN_CI_CALLER:-unknown}"
start="$(date +%s)"

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# log_line <result> <detail>: returns 1 (after a warning) when the log cannot be written.
log_line() {
  local detail
  detail="$(printf '%s' "$2" | tr '\t\n' '  ')"
  if mkdir -p "$(dirname "$LOG")" 2> /dev/null \
    && printf '%s\t%s\t%s\t%s\t%s\n' "$(now_utc)" "$SHA" "$1" "$detail" "$CALLER" >> "$LOG" 2> /dev/null; then
    return 0
  fi
  echo "$BEFORE_SHA_PREFIX: WARNING cannot write the log $LOG" >&2
  return 1
}

# refuse <message> [--no-advice]: print, log and exit 1.
refuse() {
  {
    echo "$BEFORE_SHA_PREFIX: REFUSED $SHORT: $1"
    if [ "${2:-}" != --no-advice ]; then
      echo "$BEFORE_SHA_PREFIX: ship the newest origin/main commit, or re-run the failed workflow on GitHub and try again."
    fi
    echo "$BEFORE_SHA_PREFIX: $OVERRIDE_NOTE"
  } >&2
  log_line refused "$1" || true
  exit 1
}

safe_word() { printf '%s' "$1" | tr -c 'A-Za-z0-9._@-' '_'; }

# ---- this checkout's own scripts must be origin/main's ------------------------------------------------------
# The gate only protects a checkout that already contains it: an old checkout runs old deploy scripts, and those
# do whatever their own commit said. Comparing the bytes of the scripts themselves is the only way to close that,
# so it runs before the override and before any GitHub call. It has no override: POKOIN_CI_OVERRIDE answers the
# CI question, never the question of which checkout is shipping.
SELF_CHECK_NO_OVERRIDE="This check has no override."
repo_common=

# abspath <path>: the same file written absolutely, or failure when its directory cannot be read. Parameter
# expansion and a subshell only: the gate has to keep working with a bare PATH (test case 9h).
abspath() {
  local p="$1" dir base
  case "$p" in
    */*) dir="${p%/*}" base="${p##*/}" ;;
    *) dir=. base="$p" ;;
  esac
  dir="$(cd "$dir" 2> /dev/null && pwd)" || return 1
  printf '%s/%s\n' "$dir" "$base"
}

self_check_refuse() { # <path> <why>
  local message
  message="this checkout's deploy scripts are not origin/main's ($1: $2): update the checkout (git merge --ff-only origin/main) or run from a worktree at origin/main. $SELF_CHECK_NO_OVERRIDE"
  if [ "$self_check_only" = 1 ]; then
    # this mode only answers the comparison question: the caller decides how loud the answer is
    echo "$BEFORE_SHA_PREFIX: $message" >&2
  else
    echo "$BEFORE_SHA_PREFIX: REFUSED $SHORT: $message" >&2
    log_line refused "$1: $2" || true
  fi
  exit 1
}

# self_check_file <path>: its bytes must equal origin/main's copy of the same path, in the repository being
# shipped (or in another work tree of it). Any git call that fails is a refusal.
self_check_file() {
  local file="$1" abs root file_common rel local_blob remote_blob
  abs="$(abspath "$file")" || self_check_refuse "$file" "its directory cannot be read"
  [ -f "$abs" ] || self_check_refuse "$file" "it is not a readable file"
  root="$(git -C "${abs%/*}" rev-parse --show-toplevel 2> /dev/null)" \
    || self_check_refuse "$file" "it is not inside a git work tree"
  case "$abs" in
    "$root"/*) rel="${abs#"$root"/}" ;;
    *) self_check_refuse "$file" "it lies outside the work tree $root" ;;
  esac
  file_common="$(git -C "${abs%/*}" rev-parse --path-format=absolute --git-common-dir 2> /dev/null)" \
    || self_check_refuse "$file" "its repository cannot be resolved"
  [ "$file_common" = "$repo_common" ] \
    || self_check_refuse "$file" "it belongs to another repository ($file_common), not the one being shipped"
  local_blob="$(git -C "$root" hash-object -- "$abs" 2> /dev/null)" \
    || self_check_refuse "$file" "git hash-object failed on it"
  remote_blob="$(git -C "$repo_dir" rev-parse --verify --quiet "origin/main:$rel" 2> /dev/null)" \
    || self_check_refuse "$file" "origin/main has no $rel"
  [ "$local_blob" = "$remote_blob" ] \
    || self_check_refuse "$file" "$rel differs from origin/main's copy"
}

self_check_all() {
  local file own own_dir
  own="$(abspath "${BASH_SOURCE[0]}")" \
    || self_check_refuse "${BASH_SOURCE[0]}" "the gate's own path cannot be resolved"
  repo_common="$(git -C "$repo_dir" rev-parse --path-format=absolute --git-common-dir 2> /dev/null)" \
    || self_check_refuse "--repo-dir $repo_dir" "it is not a git repository"
  git -C "$repo_dir" rev-parse --verify --quiet origin/main > /dev/null \
    || self_check_refuse "origin/main" "this checkout has not fetched it"
  self_check_file "$own"
  own_dir="${own%/*}"
  self_check_file "$own_dir/ci-required-checks"
  for file in "${caller_scripts[@]}"; do
    self_check_file "$file"
  done
}

self_check_all
if [ "$self_check_only" = 1 ]; then
  exit 0
fi

# ---- override (the self-check above is not part of it) -----------------------------------------------------
if [ -n "${POKOIN_CI_OVERRIDE:-}" ]; then
  ov="$POKOIN_CI_OVERRIDE"
  if [ -n "${LANE_WORKER+x}" ]; then
    refuse "POKOIN_CI_OVERRIDE is set in a lane worker environment and is refused whatever its value." --no-advice
  fi
  ov_sha="${ov%%:*}"
  ov_reason="${ov#*:}"
  if [ "$ov" = "$ov_sha" ] || ! [[ "$ov_sha" =~ ^[0-9a-f]{40}$ ]] || [ "$ov_sha" != "$SHA" ]; then
    refuse "POKOIN_CI_OVERRIDE must be <the full 40-hex commit id $SHA>:<reason>; the value given does not match." --no-advice
  fi
  if [ "${#ov_reason}" -lt 10 ] || ! [[ "$ov_reason" =~ ^[A-Za-z0-9\ .,\;_\(\)/#-]+$ ]]; then
    refuse "the POKOIN_CI_OVERRIDE reason must be at least 10 characters of letters, digits, space and .,;_()/#- only." --no-advice
  fi
  cat >&2 << EOF
$BEFORE_SHA_PREFIX: WARNING the required CI checks were NOT checked for $SHORT: POKOIN_CI_OVERRIDE is set.
$BEFORE_SHA_PREFIX: WARNING reason: $ov_reason
$BEFORE_SHA_PREFIX: WARNING the person who set POKOIN_CI_OVERRIDE ($(safe_word "$(id -un 2> /dev/null || echo unknown)")@$(safe_word "$(hostname 2> /dev/null || echo unknown)")) is responsible for what ships.
EOF
  who_at="$(safe_word "$(id -un 2> /dev/null || echo unknown)")@$(safe_word "$(hostname 2> /dev/null || echo unknown)")"
  caller_safe="$(safe_word "$CALLER")"
  log_line override "$ov_reason" \
    || refuse "override refused: the log line could not be written." --no-advice
  ops_cmd="${POKOIN_OPS_RECORD_CMD:-$HOME/.local/bin/lucina-rs ops record --source pokoin-ci-gate}"
  read -r -a ops_argv <<< "$ops_cmd"
  json="$(printf '{"kind":"incident","project":"pokoin","title":"CI gate overridden for %s by %s","body":"%s. Commit %s. Caller %s. Set by %s at %s. The required CI checks were not verified for this commit."}' \
    "$SHORT" "$caller_safe" "$ov_reason" "$SHA" "$caller_safe" "$who_at" "$(now_utc)")"
  if [ "${#ops_argv[@]}" -eq 0 ] || ! printf '%s\n' "$json" | "${ops_argv[@]}" > /dev/null 2>&1; then
    log_line refused "override refused: the ops record could not be written" || true
    {
      echo "$BEFORE_SHA_PREFIX: REFUSED $SHORT: override refused: the ops record could not be written (the log line was written)."
      echo "$BEFORE_SHA_PREFIX: $OVERRIDE_NOTE"
    } >&2
    exit 1
  fi
  echo "$BEFORE_SHA_PREFIX: $SHORT override accepted (logged to $LOG and recorded in ops)"
  exit 0
fi

# ---- required names ----------------------------------------------------------------------------------------
list=
if ! list="$(git -C "$repo_dir" show "$SHA:scripts/ci-required-checks" 2> /dev/null)"; then
  refuse "commit has no required-check list; it predates the CI gate or the list was emptied."
fi
required=()
while IFS= read -r line; do
  line="${line%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  if [ -n "$line" ]; then required+=("$line"); fi
done <<< "$list"
if [ "${#required[@]}" -eq 0 ]; then
  refuse "commit has no required-check list; it predates the CI gate or the list was emptied."
fi

# ---- find gh (the override never needs it) ----------------------------------------------------------------
gh_tried=
case "$GH_BIN" in
  "") if command -v gh > /dev/null 2>&1; then
      GH_BIN=gh
    else
      gh_tried="gh not on PATH; $HOME/.local/bin/gh"
      GH_BIN="$HOME/.local/bin/gh"
    fi ;;
  *) gh_tried="GH=$GH_BIN" ;;
esac
if [[ "$GH_BIN" != */* ]]; then
  command -v "$GH_BIN" > /dev/null 2>&1 || refuse "cannot find the gh binary ($gh_tried)." --no-advice
elif ! { [ -x "$GH_BIN" ] && [ -f "$GH_BIN" ]; }; then
  refuse "cannot find the gh binary ($gh_tried)." --no-advice
fi

# ---- poll --------------------------------------------------------------------------------------------------
FILTER='.check_runs[] | select((.app.slug? // "") == "github-actions") | [.id, .name, .status, (.conclusion // "none")] | @tsv'
ENDPOINT="repos/$REPO/commits/$SHA/check-runs?per_page=100"

api_fails=0
while true; do
  elapsed=$(($(date +%s) - start))
  declare -A best_id=() best_status=() best_concl=()
  api_ok=1
  api_note=
  out=
  if ! out="$("$GH_BIN" api --paginate "$ENDPOINT" --jq "$FILTER" 2> /dev/null)"; then
    api_ok=0
    api_note="gh api exited non-zero"
  else
    while IFS= read -r row; do
      [ -n "$row" ] || continue
      IFS=$'\t' read -r r_id r_name r_status r_concl r_extra <<< "$row"
      if [ -n "${r_extra:-}" ] || [ -z "${r_concl:-}" ] || ! [[ "$r_id" =~ ^[0-9]+$ ]]; then
        api_ok=0
        api_note="an answer line did not parse"
        break
      fi
      if [ -z "${best_id[$r_name]:-}" ] || [ "$r_id" -gt "${best_id[$r_name]}" ]; then
        best_id[$r_name]="$r_id"
        best_status[$r_name]="$r_status"
        best_concl[$r_name]="$r_concl"
      fi
    done <<< "$out"
  fi

  if [ "$api_ok" = 1 ]; then
    api_fails=0
    pending=()
    green=()
    for name in "${required[@]}"; do
      if [ -z "${best_id[$name]:-}" ]; then
        if [ "$no_wait" = 1 ] || [ "$elapsed" -ge "$GRACE_S" ]; then
          refuse "no $name check run on $SHORT."
        fi
        pending+=("$name (no run yet)")
      elif [ "${best_status[$name]}" != completed ]; then
        pending+=("$name (${best_status[$name]})")
      elif [ "${best_concl[$name]}" = success ]; then
        green+=("$name")
      else
        refuse "check $name finished as ${best_concl[$name]} (run ${best_id[$name]})."
      fi
    done
    if [ "${#pending[@]}" -eq 0 ]; then
      for name in "${required[@]}"; do
        echo "$BEFORE_SHA_PREFIX: $name success (run ${best_id[$name]})"
      done
      names="${required[*]}"
      echo "$BEFORE_SHA_PREFIX: $SHORT green: $names"
      log_line green "$names" || true
      exit 0
    fi
    state="pending: ${pending[*]}"
  else
    api_fails=$((api_fails + 1))
    if [ "$api_fails" -ge "$API_RETRIES" ] && [ "$no_wait" = 0 ]; then
      refuse "the GitHub API could not be read for $SHORT $api_fails times in a row ($api_note)."
    fi
    state="the GitHub API could not be read ($api_note)"
  fi

  if [ "$no_wait" = 1 ]; then
    refuse "not green yet and --no-wait was given: $state."
  fi
  if [ "$elapsed" -ge "$WAIT_S" ]; then
    if [ "$api_ok" = 0 ]; then
      refuse "the GitHub API could not be read for $SHORT after ${elapsed}s ($api_note)."
    fi
    refuse "checks still not green after ${elapsed}s: $state."
  fi
  echo "$BEFORE_SHA_PREFIX: waiting ${elapsed}s: $state"
  unset best_id best_status best_concl
  sleep "$POLL_S"
done
