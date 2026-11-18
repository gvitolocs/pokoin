#!/usr/bin/env bash
# Run on p2 only, after every inventory entry is verified. Default is read-only.
# A prepared bundle contains bin/poko-bot, bin/poko-bot.sha256, config/{env,switch.env},
# and units/{poko-bot,poko-card-x,poko-youtube-replies}.service.
set -Eeuo pipefail
umask 077
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
inventory=${X_POKO_INVENTORY:-"$here/../../../../docs/x-poko/inventory.json"}
mode=${1:---check}
[[ $mode == --check || $mode == --apply ]] || { echo 'usage: x-poko-cutover.sh [--check|--apply] /prepared/bundle' >&2; exit 2; }
# This gate is before root checks, locks, mkdir, installs or systemctl mutations.
# It fails closed: without jq, or with an inventory that cannot be read and parsed, nothing runs.
command -v jq >/dev/null 2>&1 || { echo 'CUTOVER BLOCKED: jq is required to read the parity inventory.' >&2; exit 1; }
jq -e '(.entries | type) == "array"' "$inventory" >/dev/null 2>&1 \
    || { echo "CUTOVER BLOCKED: the parity inventory is unreadable or not valid JSON: $inventory" >&2; exit 1; }
complete=$(jq -r '.complete' "$inventory")
gaps=$(jq -r '.entries[] | select(.verified != true) | "  \(.id): \(.reason)"' "$inventory")
if [[ $complete != true || -n $gaps ]]; then
    echo 'CUTOVER BLOCKED: X-POKO parity is incomplete.' >&2
    [[ -z $gaps ]] || printf '%s\n' "$gaps" >&2
    exit 1
fi
bundle=$(realpath -- "${2:?prepared release bundle required}")
for path in bin/poko-bot bin/poko-bot.sha256 config/env config/switch.env units/poko-bot.service units/poko-card-x.service units/poko-youtube-replies.service; do
    [[ -f $bundle/$path && ! -L $bundle/$path ]] || { echo "Missing regular bundle file: $path" >&2; exit 1; }
done
[[ $(stat -c '%a' "$bundle/config/env") == 600 && $(stat -c '%a' "$bundle/config/switch.env") == 600 ]] || { echo 'Bundle credential/config files must be 0600' >&2; exit 1; }
(cd -- "$bundle/bin" && sha256sum --status -c poko-bot.sha256)
# Do not source EnvironmentFile as shell: it is configuration, not trusted code.
python3 - "$bundle" <<'PY'
import os,pathlib,shlex,subprocess,sys
root=pathlib.Path(sys.argv[1]); env={'PATH':'/usr/bin:/bin'}
for name in ['env','switch.env']:
    for line in (root/'config'/name).read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'): continue
        key,sep,value=line.partition('=')
        if not sep or not key.replace('_','a').isalnum(): raise SystemExit('Unsupported environment file syntax')
        words=shlex.split(value,comments=False,posix=True)
        if len(words)>1: raise SystemExit('Quote environment values containing spaces')
        env[key]=words[0] if words else ''
result=subprocess.run([str(root/'bin/poko-bot'),'check-hospital-config'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
if result.returncode: raise SystemExit('Hospital configuration preflight failed; configure the P-OPS Rust endpoint')
if env.get('POKO_BOT_BRAIN_MODE')!='rust': raise SystemExit('Retirement requires POKO_BOT_BRAIN_MODE=rust')
PY
if [[ $mode == --check ]]; then echo 'Read-only preflight passed; no production changes made.'; exit 0; fi
[[ $EUID == 0 && $(hostname -s) == p2 ]] || { echo '--apply must run as root on p2' >&2; exit 1; }
exec 9>/run/x-poko-cutover.lock
flock -n 9 || { echo 'Another cutover holds the lock' >&2; exit 1; }
backup=$(mktemp -d /var/lib/x-poko-rollback.XXXXXXXX)
units=(poko-bot.service hermes-poko.service poko-card-x.timer poko-youtube-replies.timer)
for unit in "${units[@]}"; do
    if systemctl is-active --quiet "$unit"; then echo "$unit" >> "$backup/active"; fi
    if systemctl is-enabled --quiet "$unit"; then echo "$unit" >> "$backup/enabled"; fi
done
# Preserve permissions and exact old config/unit files. Never print their contents.
paths=(/opt/poko-bot/bin/poko-bot /etc/poko-bot/env /etc/poko-bot/switch.env /etc/systemd/system/poko-bot.service /etc/systemd/system/poko-card-x.service /etc/systemd/system/poko-youtube-replies.service)
for path in "${paths[@]}"; do [[ -f $path ]] || { echo "Missing rollback input: $path" >&2; exit 1; }; done
tar -P -cpf "$backup/previous.tar" -- "${paths[@]}"
mutated=false
rollback() {
    local status=$?
    trap - ERR INT TERM
    if [[ $status == 0 ]]; then status=1; fi
    if [[ $mutated == true ]]; then
        echo "Cutover failed; restoring $backup" >&2
        # Re-establish exclusive ownership before bringing the old services back.
        systemctl stop poko-card-x.timer poko-youtube-replies.timer poko-card-x.service poko-youtube-replies.service poko-bot.service hermes-poko.service || true
        tar -P -xpf "$backup/previous.tar"
        systemctl daemon-reload
        for unit in "${units[@]}"; do
            if [[ -f $backup/enabled ]] && grep -Fxq "$unit" "$backup/enabled"; then systemctl enable "$unit"; else systemctl disable "$unit" || true; fi
        done
        if [[ -f $backup/active ]]; then
            while IFS= read -r unit; do systemctl start "$unit" || echo "ROLLBACK NEEDS OPERATOR: $unit did not start" >&2; done < "$backup/active"
        fi
    fi
    exit "${status:-1}"
}
trap rollback ERR INT TERM
mutated=true
# Stop timers and in-flight one-shots before replacing state writers.
systemctl stop poko-card-x.timer poko-youtube-replies.timer poko-card-x.service poko-youtube-replies.service
# No second Telegram consumer: old owners are stopped before the new binary starts.
systemctl stop poko-bot.service hermes-poko.service
install -m 0755 "$bundle/bin/poko-bot" /opt/poko-bot/bin/poko-bot
install -m 0600 -o poko-bot -g poko-bot "$bundle/config/env" /etc/poko-bot/env
install -m 0600 -o poko-bot -g poko-bot "$bundle/config/switch.env" /etc/poko-bot/switch.env
for unit in poko-bot poko-card-x poko-youtube-replies; do install -m 0644 "$bundle/units/$unit.service" "/etc/systemd/system/$unit.service"; done
systemctl daemon-reload
systemctl start poko-bot.service
python3 - <<'PY'
import json,time,urllib.request
required=['D05-D20','J10','J09','H36','H37','H38','H39-H40','H41','X27-X28','H17-F17','poko-card-x','poko-youtube-replies','POKO_HOSPITAL_URL']
for _ in range(45):
    try:
        with urllib.request.urlopen('http://127.0.0.1:8790/health',timeout=2) as r: data=json.load(r)
        if data.get('ok') and all(data.get('entryPoints',{}).get(k)=='ready' for k in required): break
    except (OSError,ValueError): pass
    time.sleep(1)
else: raise SystemExit('Native entry-point health verification failed')
PY
# This script never runs a publishing job as a health check.
for unit in poko-card-x.timer poko-youtube-replies.timer; do
    if [[ -f $backup/active ]] && grep -Fxq "$unit" "$backup/active"; then systemctl start "$unit"; fi
done
systemctl disable hermes-poko.service
trap - ERR INT TERM
echo "p2 cutover passed. Rollback archive: $backup/previous.tar"
echo 'J15/J16 on nezopt require their own verified handover; see the runbook.'
