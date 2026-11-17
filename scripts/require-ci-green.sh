#!/usr/bin/env bash
# Refuse to ship a commit unless every required GitHub check run is green on it. docs/CI.md, "Deploy gate".
#
#   scripts/require-ci-green.sh [--repo-dir DIR] [--no-wait] <commit>
#
# Exit 0: every check named in scripts/ci-required-checks (as committed in <commit>) is a green GitHub Actions
# check run on <commit>, or the owner's override was given. Exit 1: refused. Exit 2: usage error.
# Any doubt is a refusal: an API error, an answer that does not parse, a missing run, a missing list.
#
# Environment (all optional):
#   GH                          the gh binary (default: gh)
#   POKOIN_CI_REPO              GitHub repository (default: gvitolocs/pokoin)
#   POKOIN_CI_POLL_S            seconds between polls (default 30)
#   POKOIN_CI_WAIT_S            give up after this many seconds (default 3600)
#   POKOIN_CI_MISSING_GRACE_S   how long a check run may be absent before it is a refusal (default 300)
#   POKOIN_CI_LOG               log file (default: $HOME/pokoin-deploy/ci-gate.log)
#   POKOIN_CI_CALLER            who is calling, for the log (default: unknown)
#   POKOIN_CI_OVERRIDE          the owner's emergency switch: <full 40-hex commit id>:<reason>
#   POKOIN_OPS_RECORD_CMD       command that takes one JSON object on stdin (default: lucina-rs ops record)
set -euo pipefail

BEFORE_SHA_PREFIX="require-ci-green"
OVERRIDE_NOTE="POKOIN_CI_OVERRIDE is the owner's emergency switch: it needs the exact commit id and a reason, and every use is written to the log and to the ops record. An agent never sets it (worker environments do not pass it): if you are an agent, stop and report."

usage() {
  echo "usage: require-ci-green.sh [--repo-dir DIR] [--no-wait] <commit>" >&2
  exit 2
}

repo_dir=.
no_wait=0
commit_arg=
while [ $# -gt 0 ]; do
  case "$1" in
    --repo-dir)
      [ $# -ge 2 ] || usage
      repo_dir="$2"
      shift 2
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
[ -n "$commit_arg" ] || usage

SHA="$(git -C "$repo_dir" rev-parse --verify "${commit_arg}^{commit}" 2> /dev/null)" || {
  echo "$BEFORE_SHA_PREFIX: cannot resolve '$commit_arg' to a commit in $repo_dir" >&2
  exit 2
}
SHORT="${SHA:0:12}"

GH_BIN="${GH:-gh}"
REPO="${POKOIN_CI_REPO:-gvitolocs/pokoin}"
POLL_S="${POKOIN_CI_POLL_S:-30}"
WAIT_S="${POKOIN_CI_WAIT_S:-3600}"
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

# ---- override, checked first -------------------------------------------------------------------------------
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

# ---- poll --------------------------------------------------------------------------------------------------
FILTER='.check_runs[] | select((.app.slug? // "") == "github-actions") | [.id, .name, .status, (.conclusion // "none")] | @tsv'
ENDPOINT="repos/$REPO/commits/$SHA/check-runs?per_page=100"

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
