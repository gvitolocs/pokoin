#!/usr/bin/env bash
# Model-check the desk/shop gesture exclusivity spec with the same pinned
# JRE + TLC jar as the Orchestra FlashFirst / TaskGraphLeases checks.
# Safety and liveness must pass; W1..W5 witnesses must FAIL (rc 12) or the
# model is over-tightened.
set -euo pipefail
readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SPEC_DIR="${ROOT_DIR}/specs"
readonly TOOLCHAIN="/home/nez/deepseek-harness-local/formal/orchestra-tlc/toolchain"
readonly JAVA_BIN="${TOOLCHAIN}/jre/usr/lib/jvm/java-17-openjdk-amd64/bin/java"
readonly TLC_JAR="${TOOLCHAIN}/tla2tools.jar"
readonly TIMEOUT_SECONDS="${GESTURE_TLC_TIMEOUT_SECONDS:-300}"
[[ -x "${JAVA_BIN}" && -r "${TLC_JAR}" ]] || { echo "pinned TLC toolchain missing" >&2; exit 2; }

run_check() {
  local kind="$1" cfg="$2"
  printf 'GESTURE_CHECK_BEGIN kind=%s config=%s\n' "${kind}" "${cfg}"
  set +e
  (cd "${SPEC_DIR}" && timeout --foreground "${TIMEOUT_SECONDS}" "${JAVA_BIN}" -XX:+UseParallelGC \
     -cp "${TLC_JAR}" tlc2.TLC -config "${cfg}.cfg" -workers auto \
     -metadir "${SPEC_DIR}/states/${kind}" GestureExclusivity.tla)
  local rc=$?
  set -e
  printf 'GESTURE_CHECK_END kind=%s rc=%s\n' "${kind}" "${rc}"
  return "${rc}"
}

failed=0

# Hand-translated TLA+ lives in the file; still run pcal when the marker is empty.
cd "${SPEC_DIR}"
if grep -q '^\* BEGIN TRANSLATION$' GestureExclusivity.tla && \
   ! grep -q '^VARIABLES banding' GestureExclusivity.tla; then
  "${JAVA_BIN}" -cp "${TLC_JAR}" pcal.trans -nocfg GestureExclusivity.tla
fi

echo "== TLC GestureExclusivity (safety)"
run_check G1-safety GestureExclusivity || failed=1

echo "== TLC G2-liveness"
run_check G2-liveness G2-liveness || failed=1

# Witnesses must FAIL (rc 12 = invariant violated): each proves the model
# still reaches the fixed behaviour. A passing witness means the model got
# too weak to catch a regression.
for w in W1-art-band-sel W2-listing-pile W3-card-pile W4-bundle-drag W5-cart-drop; do
  rc=0
  run_check "${w}" "${w}" || rc=$?
  if [[ "${rc}" -eq 12 ]]; then
    echo "GESTURE_WITNESS ${w} reachable (expected violation, rc 12)"
  elif [[ "${rc}" -eq 0 ]]; then
    echo "GESTURE_WITNESS ${w} NOT reachable: model too weak" >&2
    failed=1
  else
    echo "GESTURE_WITNESS ${w} unexpected rc=${rc}" >&2
    failed=1
  fi
done

exit "${failed}"
