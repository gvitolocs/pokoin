#!/usr/bin/env bash
# Scanner phone assets are owned by pokoin-scanner; the Pi API is native Rust.
set -euo pipefail
source "$(dirname "$0")/_scanner-project.sh"
case "${1:-scanner}" in
  scanner) scanner_deploy phone "${2:-HEAD}" ;;
  api|all) echo 'Shared API deployment is native Rust: use scripts/deploy-pokoin-rust.sh. Phone assets: use scanner mode (scanner revision).' >&2; exit 2 ;;
  *) echo 'Usage: deploy-scan-printings-diagnostics.sh scanner [scanner-commit]' >&2; exit 2 ;;
esac
