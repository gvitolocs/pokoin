#!/usr/bin/env bash
# Model-check every TLA+ model under specs/tla with TLC.
#
#   specs/tla/run.sh                    each model's top-level *.cfg (the fixed code): must pass
#   specs/tla/run.sh --regressions      also bugs/*.cfg and design/*.cfg (must report the
#                                       recorded violation) and witness/*.cfg (must reach the
#                                       behaviour, so the fixed configs are not vacuous)
#   specs/tla/run.sh ct-reconcile ...   only these model folders
#
# Exits non-zero on any violation (or on a regression config that no longer
# reproduces). TLA2TOOLS overrides the jar (default ~/.local/share/tla/tla2tools.jar,
# the official release jar from github.com/tlaplus/tlaplus/releases). Needs Java 11+.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
jar=${TLA2TOOLS:-$HOME/.local/share/tla/tla2tools.jar}
if [ ! -f "$jar" ]; then
  echo "tla2tools.jar not found at $jar (set TLA2TOOLS)" >&2
  exit 2
fi

regressions=0
models=()
for arg in "$@"; do
  case $arg in
    --regressions) regressions=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) models+=("${arg%/}") ;;
  esac
done
if [ ${#models[@]} -eq 0 ]; then
  for d in "$here"/*/; do [ -f "$d/Model.tla" ] && models+=("$(basename "$d")"); done
fi

meta=$(mktemp -d)
trap 'rm -rf "$meta"' EXIT
failed=0

# tlc <model dir> <cfg>: runs TLC, leaves its output in $meta/out, returns its exit code
# (0 ok, 12 safety violation, 13 liveness violation, other = error).
tlc() {
  local dir=$1 cfg=$2
  (cd "$dir" && java -XX:+UseParallelGC -jar "$jar" -workers auto -noGenerateSpecTE \
      -metadir "$meta/states-$(basename "$dir")-${cfg//\//-}" \
      -config "$cfg" Model.tla) > "$meta/out" 2>&1
}

summary() {
  local states depth
  states=$(grep -oE '[0-9,]+ distinct states found' "$meta/out" | tail -1)
  depth=$(grep -oE 'depth of the complete state graph search is [0-9]+' "$meta/out" | grep -oE '[0-9]+$')
  echo "${states:-no state count}${depth:+, depth $depth}"
}

for model in "${models[@]}"; do
  dir="$here/$model"
  [ -f "$dir/Model.tla" ] || { echo "no model at $dir" >&2; failed=1; continue; }
  for cfg in "$dir"/*.cfg; do
    cfg=$(basename "$cfg")
    start=$(date +%s)
    tlc "$dir" "$cfg"; code=$?
    took=$(( $(date +%s) - start ))
    if [ $code -eq 0 ]; then
      echo "PASS  $model/$cfg: $(summary) (${took}s)"
    else
      echo "FAIL  $model/$cfg: TLC exit $code (${took}s)"
      grep -E 'Error|violated|Exception' -A6 "$meta/out" | head -30
      failed=1
    fi
  done
  [ $regressions -eq 1 ] || continue
  for cfg in "$dir"/bugs/*.cfg "$dir"/design/*.cfg "$dir"/witness/*.cfg; do
    [ -f "$cfg" ] || continue
    rel=${cfg#"$dir/"}
    tlc "$dir" "$rel"; code=$?
    if [ $code -eq 12 ] || [ $code -eq 13 ]; then
      what=$(grep -m1 -oE '(Invariant|Temporal property) [A-Za-z]+ (is|was) violated' "$meta/out")
      echo "OK    $model/$rel: ${what:-violation} (as recorded)"
    else
      echo "FAIL  $model/$rel: expected a violation, TLC exit $code"
      failed=1
    fi
  done
done
exit $failed
