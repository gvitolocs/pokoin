#!/usr/bin/env bash
# Compatibility helper: scanner deployments now belong to pokoin-scanner.
scanner_root="${POKOIN_SCANNER_REPO:-/home/nez/Projects/pokoin-scanner}"
scanner_deploy() {
  [[ -f "$scanner_root/deploy/deploy.py" ]] || { echo "Missing scanner project: $scanner_root" >&2; return 1; }
  local mode=$1 revision=${2:-HEAD}
  (cd "$scanner_root" && exec python3 deploy/deploy.py "$mode" --commit "$revision")
}
