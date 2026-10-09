#!/usr/bin/env bash
# Recognition/phone deployment moved to pokoin-scanner. Domain APIs stay Rust.
set -euo pipefail
source "$(dirname "$0")/_scanner-project.sh"
case "${1:-}" in
  scanner) scanner_deploy phone "${2:-HEAD}" ;;
  web) exec "$(dirname "$0")/deploy-web.sh" "${2:-HEAD}" ;;
  api|migrate|rollback-api) echo 'Use the native Rust API deployment and current schema procedures; legacy Node/CardVault API deployment is retired. See docs/SCAN_API.md.' >&2; exit 2 ;;
  rollback-scanner) echo 'Restore the recorded scanner phone backup from pokoin-scanner release/rollback metadata; see scanner docs/OPERATIONS.md.' >&2; exit 2 ;;
  *) echo 'Usage: deploy-scan-connect.sh scanner [scanner-commit] | web [web-commit]' >&2; exit 2 ;;
esac
