#!/usr/bin/env bash
# Verify the Slang ports in specs/logika with Sireum Logika.
#
#   specs/logika/run.sh            every *.sc here must verify, and every
#                                  `// reachable` marker must be reachable
#                                  (assert(F) there must NOT verify), so no
#                                  proof passes on an unsatisfiable path
#   specs/logika/run.sh --quick    skip the reachability probes
#
# bugs/*.sc model the code before a fix: each must FAIL to verify.
# SIREUM overrides the binary (default ~/tools/sireum/Sireum/bin/sireum, the
# official kekinian release 4.20260810.80aad0c2). Exits non-zero on any miss.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
sireum=${SIREUM:-$HOME/tools/sireum/Sireum/bin/sireum}
[ -x "$sireum" ] || { echo "sireum not found at $sireum (set SIREUM)" >&2; exit 2; }
quick=0
[ "${1:-}" = "--quick" ] && quick=1
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failed=0

verify() { "$sireum" logika verifier "$1" > "$tmp/out" 2>&1; }

for file in "$here"/*.sc; do
  name=$(basename "$file")
  start=$(date +%s)
  if verify "$file" && grep -q "Logika verified" "$tmp/out"; then
    echo "PASS  $name ($(( $(date +%s) - start ))s)"
  else
    echo "FAIL  $name"; tail -20 "$tmp/out"; failed=1; continue
  fi
  [ $quick -eq 1 ] && continue
  count=$(grep -c '// reachable' "$file")
  for n in $(seq 1 "$count"); do
    # Replace the n-th marker with assert(F); it must not verify.
    awk -v n="$n" '/\/\/ reachable/ { k++; if (k == n) { sub(/\/\/ reachable/, "assert(F) // probe") } } { print }' "$file" > "$tmp/$name"
    line=$(grep -n 'assert(F) // probe' "$tmp/$name" | cut -d: -f1)
    if verify "$tmp/$name" && grep -q "Logika verified" "$tmp/out"; then
      echo "FAIL  $name:$line is unreachable: the proof is vacuous there"; failed=1
    else
      echo "OK    $name:$line reachable"
    fi
  done
done

for file in "$here"/bugs/*.sc; do
  name=bugs/$(basename "$file")
  if verify "$file" && grep -q "Logika verified" "$tmp/out"; then
    echo "FAIL  $name verified, expected a failed obligation"; failed=1
  else
    echo "OK    $name: $(grep -m1 -oE 'Could not deduce[^.]*' "$tmp/out" || echo failed) (as recorded)"
  fi
done
exit $failed
