#!/usr/bin/env bash
# Tests the stage reporting and the SIGTERM summary of scripts/run-all-cardtrader-daily.sh
# with stub commands. Linux only (setsid). Run: bash scripts/run-all-cardtrader-daily.test.sh
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$tmp/bin" "$tmp/repo/scripts"
cp "$repo/scripts/run-all-cardtrader-daily.sh" "$tmp/repo/scripts/"
log="$tmp/calls.log"
# node: the catalogue stage; sleeps when NODE_SLEEP is set.
cat >"$tmp/bin/node" <<STUB
#!/usr/bin/env bash
echo "node \$*" >>"$log"
[[ -n "\${NODE_SLEEP:-}" ]] && sleep "\$NODE_SLEEP"
exit 0
STUB
# python3: logs the notifier call; other scripts succeed.
cat >"$tmp/bin/python3" <<STUB
#!/usr/bin/env bash
echo "python3 \$*" >>"$log"
exit 0
STUB
cat >"$tmp/bin/gpu-lease" <<'STUB'
#!/usr/bin/env bash
while [[ "$1" != "--" ]]; do shift; done
shift
exec "$@"
STUB
cat >"$tmp/bin/ok" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
cat >"$tmp/bin/dump-fails" <<'STUB'
#!/usr/bin/env bash
exit 4
STUB
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH"
export POKOIN_GPU_LEASE="$tmp/bin/gpu-lease" POKOIN_AI_PYTHON="$tmp/bin/ok" POKOIN_CT_PRICE_BIN="$tmp/bin/ok" POKOIN_CT_SOLD_BIN="$tmp/bin/ok"
export POKOIN_CATALOG_RUN_ROOT="$tmp/run"

# 1. A full run whose dump fails reports every stage and exits 1.
POKOIN_CT_DUMP_BIN="$tmp/bin/dump-fails" bash "$tmp/repo/scripts/run-all-cardtrader-daily.sh" && fail "dump failure must exit 1"
notify_line="$(grep 'cardtrader-daily-notify.py' "$log")"
for want in "--exit-code 1" "catalog=0" "pictures=0" "picture-sync=0" "artwork=0" "dump=4" "prices=0" "sold=0"; do
  [[ "$notify_line" == *"$want"* ]] || fail "full run: missing $want in: $notify_line"
done
[[ "$notify_line" != *interrupted* ]] || fail "full run marked interrupted"

# 2. SIGTERM to the unit's processes during the catalogue stage: summary marked
#    interrupted, no stage reported as passed, exit 143.
: >"$log"
NODE_SLEEP=30 POKOIN_CT_DUMP_BIN="$tmp/bin/ok" setsid bash "$tmp/repo/scripts/run-all-cardtrader-daily.sh" &
pid=$!
for _ in $(seq 50); do grep -q '^node' "$log" 2>/dev/null && break; sleep 0.1; done
kill -TERM -- "-$pid"
code=0
wait "$pid" || code=$?
[[ "$code" == 143 ]] || fail "SIGTERM exit code $code, want 143"
notify_line="$(grep 'cardtrader-daily-notify.py' "$log" || true)"
[[ -n "$notify_line" ]] || fail "no summary after SIGTERM"
[[ "$notify_line" == *"--exit-code 143"* && "$notify_line" == *"interrupted=143"* ]] || fail "SIGTERM summary: $notify_line"
[[ "$notify_line" != *"catalog="* ]] || fail "unfinished stage reported: $notify_line"
echo "run-all-cardtrader-daily: ok"
