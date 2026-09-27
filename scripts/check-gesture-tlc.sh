#!/usr/bin/env bash
# Translate (if needed) and model-check specs/GestureExclusivity.tla with TLC.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
jar="${TLA2TOOLS_JAR:-$HOME/tools/tla/tla2tools.jar}"
cache_jar="$HOME/.cache/tla/tla2tools.jar"
spec="$root/specs/GestureExclusivity"

if [[ ! -f "$jar" ]]; then
  if [[ -f "$cache_jar" ]]; then
    jar="$cache_jar"
  else
    mkdir -p "$(dirname "$cache_jar")"
    echo "== fetch tla2tools.jar -> $cache_jar"
    curl -fsSL -o "$cache_jar" \
      "https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar"
    jar="$cache_jar"
  fi
fi

java="${JAVA_HOME:+$JAVA_HOME/bin/java}"
if [[ -z "${JAVA_HOME:-}" || ! -x "$java" ]]; then
  java="$(command -v java)"
fi

cd "$root/specs"
# Hand-translated TLA+ lives in the file; still run pcal when the marker is empty.
if grep -q '^\* BEGIN TRANSLATION$' GestureExclusivity.tla && \
   ! grep -q '^VARIABLES banding' GestureExclusivity.tla; then
  "$java" -cp "$jar" pcal.trans -nocfg GestureExclusivity.tla
fi

echo "== TLC GestureExclusivity"
"$java" -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
  -config GestureExclusivity.cfg \
  -workers auto \
  -cleanup \
  GestureExclusivity.tla
