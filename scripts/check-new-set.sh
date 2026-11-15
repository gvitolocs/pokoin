#!/usr/bin/env bash
# Public read-only readiness check; implementation uses Python's standard library.
set -euo pipefail
exec python3 -B "$(dirname "$0")/check-new-set.py" "$@"
