#!/usr/bin/env bash
# Automatic deploy of the Pokoin Rust API from origin/main (docs/AUTO_DEPLOY.md). Built switched off:
# nothing runs it until the owner enables deploy/systemd/pokoin-rust-auto-deploy.{path,timer}.
#
# Newest main only: commits that landed meanwhile are coalesced into the tip, and a commit that lands during a
# run gets one more round when this one ends. One run at a time (flock). A sha that failed is never retried by
# itself; the next main commit starts afresh. A deploy never goes out when scripts/sql/ changed in the range:
# migrations are applied by hand first (exit 3).
#
# usage: scripts/auto-deploy-rust.sh [--dry-run | --status | --ack-migrations <sha>]
#   --dry-run          print the plan (range, changed paths, decision) and run nothing; no fetch, no state change
#   --status           last 10 state lines and whether the pause file exists
#   --ack-migrations   the owner applied the migrations of that exact sha: let the next run deploy it
# env: POKOIN_AUTODEPLOY_DIR (state, default ~/scratch/pokoin-auto-deploy), POKOIN_AUTODEPLOY_REPO (checkout to
#   read, default the one this script lives in), POKOIN_DEPLOY_DIR (default ~/pokoin-deploy), GIT,
#   BUILD_CMD (run with the sha), DEPLOY_CMD (run in DEPLOY_CWD, default $POKOIN_DEPLOY_DIR/rust-release),
#   SYNC_CMD, STATUS_CMD (prints "rust release: releases/<sha12>, Pi: <sha12>"), HEALTH_URL (https URL whose
#   x-pokoin-release header is the Pi's release; a file path or file:// URL holds the sha, for tests),
#   HEALTH_WAIT_S (120), HEALTH_INTERVAL_S (5).
# exit: 0 done / skipped / paused / stalled / busy, 1 a step failed, 2 cannot plan, 3 migration-pending.
set -euo pipefail

root=${POKOIN_AUTODEPLOY_REPO:-$(cd "$(dirname "$0")/.." && pwd)}
# A run lasts an hour and the checkout this file lives in moves with every merge: bash reads a script as it
# goes, so run from a copy.
if [[ -z "${AUTODEPLOY_COPY:-}" ]]; then
  self=$(mktemp "${TMPDIR:-/tmp}/auto-deploy-rust.XXXXXX")
  cp "$0" "$self"
  AUTODEPLOY_COPY="$self" POKOIN_AUTODEPLOY_REPO="$root" exec bash "$self" "$@"
fi
trap 'rm -f "$AUTODEPLOY_COPY"' EXIT

st=${POKOIN_AUTODEPLOY_DIR:-$HOME/scratch/pokoin-auto-deploy}
deploy_dir=${POKOIN_DEPLOY_DIR:-$HOME/pokoin-deploy}
GIT=${GIT:-git}
BUILD_CMD=${BUILD_CMD:-$root/scripts/build-pokoin-rust-release.sh}
DEPLOY_CWD=${DEPLOY_CWD:-$deploy_dir/rust-release}
DEPLOY_CMD=${DEPLOY_CMD:-scripts/deploy-pokoin-rust.sh}
SYNC_CMD=${SYNC_CMD:-$root/scripts/nezopt-k3s.sh sync}
STATUS_CMD=${STATUS_CMD:-$root/scripts/nezopt-k3s.sh status}
HEALTH_URL=${HEALTH_URL:-https://api.pokoin.com/healthz}
HEALTH_WAIT_S=${HEALTH_WAIT_S:-120}
HEALTH_INTERVAL_S=${HEALTH_INTERVAL_S:-5}

mode=run ack=""
case "${1:-}" in
  "") ;;
  --dry-run) mode=dry ;;
  --status) mode=status ;;
  --ack-migrations) mode=ack; ack=${2:?--ack-migrations needs a sha} ;;
  *) echo "usage: $0 [--dry-run | --status | --ack-migrations <sha>]" >&2; exit 2 ;;
esac

mkdir -p "$st/log"
logf=$st/log/results.log
log() { echo "$(date -u +%FT%TZ) auto-deploy-rust: $*"; }
g() { "$GIT" -C "$root" "$@"; }
indent() { local l; while IFS= read -r l; do printf '    %s\n' "$l"; done <<< "$1"; }
state_of() { # sha -> last state word, empty when unknown
  [[ -f "$st/state" ]] || return 0
  awk -v s="$1" '$1 == s { v = $2 } END { if (v) print v }' "$st/state"
}
record() { printf '%s %s%s\n' "$1" "$2" "${3:+ $3}" >> "$st/state"; }
last_done() { # newest sha recorded done that this repo still knows
  [[ -f "$st/state" ]] || return 0
  local s
  while read -r s; do
    if g cat-file -e "$s^{commit}" 2> /dev/null; then echo "$s"; return 0; fi
  done < <(awk '$2 == "done" { print $1 }' "$st/state" | tac)
}
pi_release() { # the sha the Pi serves, empty when unknown
  local v=""
  case "$HEALTH_URL" in
    file://*) v=$(head -n1 "${HEALTH_URL#file://}" 2> /dev/null || true) ;;
    http*) v=$(curl -fsSI --max-time 10 --retry 2 "$HEALTH_URL" 2> /dev/null | tr -d '\r' | awk 'tolower($1) == "x-pokoin-release:" { print $2 }' || true) ;;
    *) v=$(head -n1 "$HEALTH_URL" 2> /dev/null || true) ;;
  esac
  if [[ "$v" =~ ^[0-9a-f]{40}$ ]]; then echo "$v"; fi
  return 0
}

if [[ $mode == status ]]; then
  if [[ -f "$st/state" ]]; then tail -n 10 "$st/state"; else echo "(no state yet)"; fi
  if [[ -e "$st/pause" ]]; then echo "PAUSED: $st/pause exists"; else echo "not paused"; fi
  exit 0
fi
if [[ -e "$st/pause" ]]; then
  log "paused ($st/pause exists): $(head -c 300 "$st/pause" | tr '\n' ' ')"
  exit 0
fi
if [[ $mode == ack ]]; then
  full=$(g rev-parse --verify "$ack^{commit}") || { log "unknown commit $ack"; exit 2; }
  echo "$full" >> "$st/acked"
  # a failed sha is final; stalled lets the next trigger deploy this one
  record "$full" stalled "ack-migrations by $(id -un)"
  log "migrations of $full acknowledged: the next run may deploy exactly this sha"
  exit 0
fi

if [[ $mode == run ]]; then
  exec 9> "$st/lock"
  flock -n 9 || { log "another run is going"; exit 0; }
fi

fetch() { g fetch -q origin; }
tip_of() { g rev-parse --verify "refs/remotes/origin/main^{commit}"; }

# plan <tip>: sets decision (deploy|skip|migration|nobase), reason, base, changed (paths), sqlfiles
plan() {
  local tip=$1 pi done_sha
  decision=skip reason="" base="" changed="" sqlfiles=""
  case "$(state_of "$tip")" in
    done | failed) reason="tip already $(state_of "$tip")"; return 0 ;;
  esac
  done_sha=$(last_done)
  pi=$(pi_release)
  if [[ -n "$pi" ]] && ! g cat-file -e "$pi^{commit}" 2> /dev/null; then pi=""; fi
  # the newer of: last sha this automation deployed, what the Pi runs (a hand deploy moves the Pi on)
  if [[ -n "$done_sha" && -n "$pi" ]]; then
    if g merge-base --is-ancestor "$done_sha" "$pi"; then base=$pi; else base=$done_sha; fi
  else
    base=${done_sha:-$pi}
  fi
  if [[ -z "$base" ]]; then
    decision=nobase reason="no last done sha and the Pi release is unreadable ($HEALTH_URL)"
    return 0
  fi
  if [[ "$base" == "$tip" ]]; then reason="tip is already deployed"; return 0; fi
  changed=$(g diff --name-only "$base" "$tip" -- pokoin-rust deploy/systemd/pokoin-rust-api.service)
  sqlfiles=$(g diff --name-only "$base" "$tip" -- scripts/sql)
  if [[ -z "$changed" ]]; then
    reason="nothing under pokoin-rust/ or the api unit changed since ${base:0:12}"
    return 0
  fi
  if [[ -n "$sqlfiles" ]] && ! grep -qx "$tip" "$st/acked" 2> /dev/null; then
    decision=migration reason="migration-pending"
    return 0
  fi
  decision=deploy reason="pokoin-rust changed since ${base:0:12}${sqlfiles:+ (migrations acknowledged)}"
}

step() { # name cwd command args... : output to the sha log; returns the command's status
  local name=$1 cwd=$2 cmd=$3
  shift 3
  log "step $name" | tee -a "$logf"
  (cd "$cwd" && bash -c "$cmd \"\$@\"" _ "$@") >> "$logf" 2>&1
}

verify() { # sha: the Pi serves it, and the overflow shows the same release
  local sha=$1 end got out
  end=$((SECONDS + HEALTH_WAIT_S))
  while :; do
    got=$(pi_release)
    [[ "$got" == "$sha" ]] && break
    if ((SECONDS >= end)); then
      log "verify: x-pokoin-release is '${got:-none}', wanted $sha" | tee -a "$logf"
      return 1
    fi
    sleep "$HEALTH_INTERVAL_S"
  done
  out=$(cd "$root" && bash -c "$STATUS_CMD" 2>&1) || true
  printf '%s\n' "$out" >> "$logf"
  if ! grep -E '^rust release:' <<< "$out" | grep -q "releases/${sha:0:12}"; then
    log "verify: overflow release is not ${sha:0:12}" | tee -a "$logf"
    return 1
  fi
  return 0
}

run_sha() { # tip: build, deploy, sync, verify; records the final state
  local tip=$1 failed_step=""
  record "$tip" started
  logf=$st/log/$tip.log
  : > "$logf"
  log "deploying $tip" | tee -a "$logf"
  if ! step build "$root" "$BUILD_CMD" "$tip"; then
    if grep -q "Not starting the build" "$logf"; then
      record "$tip" stalled "build refused: low disk"
      log "stalled: the build refused to start (disk); the next trigger retries" | tee -a "$logf"
      return 0
    fi
    failed_step=build
  elif ! step deploy "$DEPLOY_CWD" "$DEPLOY_CMD"; then failed_step=deploy
  elif ! step sync "$root" "$SYNC_CMD"; then failed_step=sync
  elif ! verify "$tip"; then failed_step=verify
  fi
  if [[ -n "$failed_step" ]]; then
    record "$tip" failed "$failed_step"
    log "FAILED at $failed_step for $tip (log: $logf). Not retried; see docs/AUTO_DEPLOY.md" | tee -a "$logf"
    return 1
  fi
  record "$tip" "done"
  log "done: $tip is live on the Pi and the overflow" | tee -a "$logf"
  return 0
}

# One summary line per final state. The owner hears about a failure because the script then exits non-zero, which
# fails the unit and fires the user-wide OnFailure= drop-in (pokoin-notify@, mail + push). A success is only logged.
report() { echo "$(date -u +%FT%TZ) $*" >> "$st/log/results.log"; }

if [[ $mode == dry ]]; then
  tip=$(tip_of) || { log "no origin/main in $root"; exit 2; }
  plan "$tip"
  echo "dry run (no fetch: origin/main as this checkout last saw it)"
  echo "  tip:      $tip"
  echo "  base:     ${base:-unknown}"
  echo "  decision: $decision"
  echo "  reason:   $reason"
  if [[ -n "$changed" ]]; then echo "  changed:"; indent "$changed"; fi
  if [[ -n "$sqlfiles" ]]; then echo "  scripts/sql:"; indent "$sqlfiles"; fi
  if [[ $decision == deploy ]]; then
    echo "  would run: $BUILD_CMD $tip; (cd $DEPLOY_CWD && $DEPLOY_CMD); $SYNC_CMD; verify $HEALTH_URL and the overflow release"
  fi
  exit 0
fi

rc=0
for round in 1 2; do
  fetch || { log "git fetch origin failed"; exit 2; }
  tip=$(tip_of) || { log "no origin/main in $root"; exit 2; }
  plan "$tip"
  case $decision in
    skip)
      case "$(state_of "$tip")" in done | failed | skipped) ;; *) record "$tip" skipped "$reason" ;; esac
      log "skip $tip: $reason"
      ;;
    nobase)
      record "$tip" failed "no-baseline"
      log "FAILED: $reason"
      report "$tip failed no-baseline"
      exit 2
      ;;
    migration)
      record "$tip" failed migration-pending
      {
        log "migration-pending for $tip: scripts/sql changed since ${base:0:12}; not deploying. Files:"
        indent "$sqlfiles"
        log "apply them on the writer, then deploy by hand, or: scripts/auto-deploy-rust.sh --ack-migrations $tip"
      } | tee "$st/log/$tip.log"
      report "$tip failed migration-pending"
      rc=3
      ;;
    deploy)
      if run_sha "$tip"; then
        if [[ "$(state_of "$tip")" == "done" ]]; then report "$tip done"; fi
      else
        report "$tip failed (log: $st/log/$tip.log)"
        rc=1
      fi
      ;;
  esac
  # a commit that landed during the run gets one more round
  if [[ $round == 2 || $rc != 0 ]]; then break; fi
  fetch || break
  if [[ "$(tip_of)" == "$tip" ]]; then break; fi
done
exit "$rc"
