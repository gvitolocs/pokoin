#!/usr/bin/env bash
# Verify pokoin-rust/verus/*.rs with Verus. VERUS overrides the binary
# (default ~/tools/verus/verus-x86-linux/verus, a release from
# github.com/verus-lang/verus/releases unpacked in user space).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
verus=${VERUS:-$HOME/tools/verus/verus-x86-linux/verus}
[ -x "$verus" ] || { echo "verus not found at $verus (set VERUS)" >&2; exit 2; }
status=0
for file in "$here"/*.rs; do
  printf '%s: ' "$(basename "$file")"
  "$verus" "$file" 2>&1 | tail -1 || status=1
done
exit $status
