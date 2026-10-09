#!/usr/bin/env bash
# Compatibility: argument is now a pokoin-scanner commit, not a Pokoin Web commit.
set -euo pipefail
source "$(dirname "$0")/_scanner-project.sh"
scanner_deploy gpu "${1:-HEAD}"
