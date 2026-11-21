#!/usr/bin/env bash
# Tests install-ops-{nezopt,pi,oracle}.sh with stubs only: ssh, scp, sudo, install, systemctl, cp and the
# like record their calls (ssh runs the privileged step's script locally, scp and cp copy into the test
# home, nothing else is executed). Configuration is dummy files in a temp dir with marker values.
# Run: bash scripts/backup/install-ops.test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
# shellcheck disable=SC1091
lib() { source "$here/install-ops-lib.sh"; }

home="$tmp/home"; etc="$tmp/etc"
mkdir -p "$tmp/stubs" "$home/.local/bin" "$tmp/dist/x86_64" "$tmp/dist/aarch64"
export LOG="$tmp/log" STUB_MARKER="$tmp/marker"

# Every host-changing command is a stub that only logs its name and arguments.
for c in systemctl docker mountpoint pokoin-ops wal-g; do
  cat >"$tmp/stubs/$c" <<'STUB'
#!/usr/bin/env bash
echo "$(basename "$0") $*" >>"$LOG"
exit 0
STUB
  chmod +x "$tmp/stubs/$c"
done
cp "$tmp/stubs/pokoin-ops" "$home/.local/bin/pokoin-ops"
# install logs its call and the sha256 of its source file. STUB_SWAP_AT_INSTALL=1 changes the files in the user staging
# directory before the first install call returns (a swap after the root step has copied and verified them).
cat >"$tmp/stubs/install" <<'STUB'
#!/usr/bin/env bash
echo "install $*" >>"$LOG"
if [[ "${STUB_SWAP_AT_INSTALL:-0}" == 1 && ! -e "$STUB_MARKER.swapped" ]]; then
  : >"$STUB_MARKER.swapped"
  for f in "$HOME"/.pokoin-stage.*/*; do [[ -f "$f" ]] && echo swapped >>"$f"; done
fi
src="${*: -2:1}"
if [[ -f "$src" ]]; then echo "installsrc $(sha256sum "$src" | cut -d' ' -f1) $src" >>"$LOG"; fi
exit 0
STUB
# mktemp: the real one, and it logs the mode of the directory it made.
cat >"$tmp/stubs/mktemp" <<'STUB'
#!/usr/bin/env bash
d="$(/usr/bin/mktemp "$@")" || exit 1
echo "mktemp-mode $(stat -c %a "$d") $d" >>"$LOG"
echo "$d"
STUB
# shellcheck disable=SC2016  # the stub expands its own arguments
printf '#!/usr/bin/env bash\necho "$1: ELF 64-bit LSB executable, ARM aarch64"\n' >"$tmp/stubs/file"
# ssh: runs a command locally only when it names a staging directory (mktemp, the privileged step, rm).
cat >"$tmp/stubs/ssh" <<'STUB'
#!/usr/bin/env bash
echo "ssh $*" >>"$LOG"
args=("$@")
while [[ "${args[0]:-}" == -o ]]; do args=("${args[@]:2}"); done
cmd="${args[*]:1}"
case "$cmd" in
  *.pokoin-stage.*) exec bash -c "$cmd" ;;
esac
if [[ -n "${STUB_SWAP_AT_TESTF:-}" && "$*" == *"test -f "*"/alerts.env"* ]]; then echo swapped >>"$HOME"/.pokoin-stage.*/"$STUB_SWAP_AT_TESTF"; fi
if [[ "${STUB_NOFILE:-0}" == 1 && "$*" == *"test -f "*"/alerts.env"* ]]; then exit 1; fi
[[ -t 0 ]] || cat >>"$LOG"
exit 0
STUB
# sudo: drops its flags and runs the rest.
cat >"$tmp/stubs/sudo" <<'STUB'
#!/usr/bin/env bash
echo "sudo $*" >>"$LOG"
while [[ "${1:-}" == -* ]]; do shift; done
exec "$@"
STUB
# scp and cp copy into a staging directory under the test home; STUB_CORRUPT=1 changes the copy.
cat >"$tmp/stubs/scp" <<'STUB'
#!/usr/bin/env bash
echo "scp $*" >>"$LOG"
src="${*: -2:1}"; dst="${*: -1}"; dst="${dst#*:}"
case "$dst" in
  "$HOME"/.pokoin-stage.*) /bin/cp "$src" "$dst"; if [[ "${STUB_CORRUPT:-0}" == 1 || "$(basename "$dst")" == "${STUB_CORRUPT_ONLY:-}" ]]; then echo x >>"$dst"; fi ;;
esac
exit 0
STUB
cat >"$tmp/stubs/cp" <<'STUB'
#!/usr/bin/env bash
/bin/cp "$@"; rc=$?
dst="${*: -1}"
if [[ ("${STUB_CORRUPT:-0}" == 1 || "$(basename "$dst")" == "${STUB_CORRUPT_ONLY:-}") && "$dst" == "$HOME"/.pokoin-stage.*/* ]]; then echo x >>"$dst"; fi
exit "$rc"
STUB
chmod +x "$tmp/stubs/"*
# The "binary" the installers deploy writes a marker file if it is ever executed.
for arch in x86_64 aarch64; do
  # shellcheck disable=SC2016  # the stub expands its own variable
  printf '#!/usr/bin/env bash\n: >"$STUB_MARKER"\nexit 0\n' >"$tmp/dist/$arch/pokoin-ops"
  chmod +x "$tmp/dist/$arch/pokoin-ops"
done

# copy_scripts <name>: prints the scripts directory of a fresh copy of the installers (deploy/ is linked, not
# copied). In the copy the fixed /etc/pokoin path is replaced by the test directory, so no test reads a host file.
copy_scripts() {
  local m="$tmp/mut/$1"
  rm -rf "$m"; mkdir -p "$m/scripts/backup"
  cp "$here"/install-ops-*.sh "$here/walspool-archive.sh" "$m/scripts/backup/"
  perl -pi -e "s{/etc/pokoin}{$etc}g" "$m"/scripts/backup/install-ops-*.sh
  ln -s "$repo/deploy" "$m/deploy"
  echo "$m/scripts/backup"
}
sd="$(copy_scripts main)"

# run <script> [args]: the script's exit code in $rc_out, its output in $tmp/out, commands in $LOG.
run() {
  : >"$LOG"; rm -f "$STUB_MARKER.swapped"
  set +e
  HOME="$home" PATH="$tmp/stubs:$PATH" POKOIN_OPS_DIST="$tmp/dist" bash "$@" >"$tmp/out" 2>&1 </dev/null
  rc_out=$?
  set -e
}
# cfg <alerts.env text>: the host's alert configuration is one dummy file (an empty text: none).
cfg() {
  rm -rf "$etc" "$home/.config/pokoin/alerts.env"; mkdir -p "$etc" "$home/.config/pokoin"
  [[ -z "${1:-}" ]] || printf '%s\n' "$1" >"$etc/alerts.env"
}
good_cfg() { cfg "POKOIN_ALERT_MAIL_FROM=marker-from-value
POKOIN_ALERT_MAIL_TO=marker-to-value"; }
no_stage_left() {
  ! compgen -G "$home/.pokoin-stage.*" >/dev/null || fail "$1: the staging directory was not removed"
  ! compgen -G "$home/.pokoin-root.*" >/dev/null || fail "$1: the root work directory was not removed"
}
no_values() { ! grep -q marker "$tmp/out" || fail "$1: output shows a value"; }

# The scripts name no fixed /tmp path, never call the new binary, and stage with mktemp -d.
for s in nezopt pi oracle; do
  f="$here/install-ops-$s.sh"
  ! grep -q '/tmp/' "$f" || fail "$s: a fixed /tmp path"
  ! grep -q 'mail-config-check' "$f" || fail "$s: calls mail-config-check"
  grep -q 'mktemp -d' "$f" || fail "$s: no mktemp -d staging"
  grep -q 'trap stage_close EXIT' "$f" || fail "$s: no cleanup trap"
done

# A missing sender: refused before any install, key name and paths shown, no value, staging removed.
refused_for_missing_sender() { # <label> <script> [args]
  local s="$1"; shift
  cfg "POKOIN_ALERT_MAIL_TO=marker-to-value"
  run "$@"
  [[ "$rc_out" != 0 ]] || fail "$s: a missing sender must fail the script"
  grep -q "install refused" "$tmp/out" || fail "$s: no refusal line"
  grep -q "missing: POKOIN_ALERT_MAIL_FROM (looked in: $etc/uptime-mail.env, $etc/alerts.env, " "$tmp/out" || fail "$s: refusal lacks the key name and paths"
  no_values "$s"
  ! grep -q '^install ' "$LOG" || fail "$s: install ran after a failed check"
  no_stage_left "$s"
}
refused_for_missing_sender nezopt "$sd/install-ops-nezopt.sh" alerts
refused_for_missing_sender pi "$sd/install-ops-pi.sh" alerts
grep -q 'ssh .* mktemp -d' "$LOG" || fail "pi: the staging directory was not made with mktemp -d"
grep -q "^scp .*[ :]$home/.pokoin-stage\." "$LOG" || fail "pi: nothing was staged in a private directory"
refused_for_missing_sender oracle "$sd/install-ops-oracle.sh"

# A recipient missing in both keys is refused too.
cfg "POKOIN_ALERT_MAIL_FROM=marker-from-value"
run "$sd/install-ops-pi.sh" alerts
[[ "$rc_out" != 0 ]] || fail "pi: a missing recipient must fail the script"
grep -q "missing: POKOIN_ALERT_MAIL_TO or POKOIN_UPTIME_MAIL_TO" "$tmp/out" || fail "pi: a missing recipient was not named"

# Full stubbed installs: installed from the staged copy in the private directory, nothing refused.
stage_re="$home/\.pokoin-stage\.[A-Za-z0-9]+"
good_cfg
run "$sd/install-ops-nezopt.sh" alerts
[[ "$rc_out" == 0 ]] || fail "nezopt: a complete config must pass ($(cat "$tmp/out"))"
grep -Eq "^install -D -m 755 $stage_re/1/pokoin-ops $home/.local/bin/pokoin-ops" "$LOG" || fail "nezopt: not installed from the staged copy"
! grep -q "install refused" "$tmp/out" || fail "nezopt: refused although the check passed"
no_stage_left nezopt
run "$sd/install-ops-pi.sh" alerts
[[ "$rc_out" == 0 ]] || fail "pi: a complete config must pass ($(cat "$tmp/out"))"
grep -Eq "^install -o root -g root -m 755 $stage_re/pokoin-ops /usr/local/bin/pokoin-ops" "$LOG" || fail "pi: not installed from the staged copy"
grep -Eq "^install -m 644 $stage_re/pokoin-notify@.service /etc/systemd/system/pokoin-notify@.service" "$LOG" || fail "pi: a unit was not installed from the staged copy"
no_stage_left pi
run "$sd/install-ops-oracle.sh"
[[ "$rc_out" == 0 ]] || fail "oracle: a complete config must pass ($(cat "$tmp/out"))"
root_re="$home/\.pokoin-root\.[A-Za-z0-9]+"
grep -Eq "^install -o root -g root -m 755 $root_re/pokoin-ops /usr/local/bin/pokoin-ops" "$LOG" || fail "oracle: not installed from the root-owned copy"
grep -Eq "^install -D -m 644 $root_re/ct-alerts.conf " "$LOG" || fail "oracle: a drop-in was not installed from the root-owned copy"
! grep -Eq "^install .* $stage_re/" "$LOG" || fail "oracle: installed from the user staging directory"
no_stage_left oracle

# The Pi wal-g step stages and verifies its files too.
walg_bin="$tmp/walg-bin"; printf 'walg-marker-bytes' >"$walg_bin"
walg_sha="$(sha256sum "$walg_bin" | cut -d' ' -f1)"
good_cfg; printf 'MARKER_WALG=marker-walg\n' >"$etc/walg.env"
run "$sd/install-ops-pi.sh" walg "$walg_bin" "$walg_sha"
[[ "$rc_out" == 0 ]] || fail "pi walg: a stubbed install must pass ($(cat "$tmp/out"))"
grep -Eq "^install -o root -g root -m 755 $stage_re/wal-g /usr/local/bin/wal-g" "$LOG" || fail "pi walg: not installed from the staged copy"
grep -Eq "^install -o root -g root -m 755 $stage_re/walspool-archive.sh " "$LOG" || fail "pi walg: the spool script was not installed from the staged copy"
no_stage_left "pi walg"
STUB_CORRUPT=1 run "$sd/install-ops-pi.sh" walg "$walg_bin" "$walg_sha"
[[ "$rc_out" != 0 ]] || fail "pi walg: a digest mismatch must fail the script"
! grep -q '^install ' "$LOG" || fail "pi walg: installed after a digest mismatch"
no_stage_left "pi walg mismatch"

# t_marker <scripts dir>: after full stubbed installs the staged binary was never executed.
t_marker() {
  local d="$1" s
  good_cfg; rm -f "$STUB_MARKER"
  run "$d/install-ops-nezopt.sh" alerts; [[ "$rc_out" == 0 ]] || fail "nezopt: install failed"
  run "$d/install-ops-pi.sh" alerts; [[ "$rc_out" == 0 ]] || fail "pi: install failed"
  run "$d/install-ops-oracle.sh"; [[ "$rc_out" == 0 ]] || fail "oracle: install failed"
  [[ ! -e "$STUB_MARKER" ]] || fail "the staged binary was executed by an installer"
  s=ok
}
# t_digest <scripts dir>: a staged file that no longer matches its digest is refused before any install.
t_digest() {
  local d="$1" s
  for s in nezopt pi oracle; do
    good_cfg
    case "$s" in
      oracle) STUB_CORRUPT=1 run "$d/install-ops-oracle.sh" ;;
      *) STUB_CORRUPT=1 run "$d/install-ops-$s.sh" alerts ;;
    esac
    [[ "$rc_out" != 0 ]] || fail "$s: a digest mismatch must fail the script"
    grep -Eq '^digest mismatch: expected [0-9a-f]{12}, got [0-9a-f]{12}$' "$tmp/out" || fail "$s: no digest mismatch line"
    grep -q "install refused" "$tmp/out" || fail "$s: no refusal line"
    ! grep -q '^install ' "$LOG" || fail "$s: install ran after a digest mismatch"
    no_values "$s"
    no_stage_left "$s"
  done
}
t_marker "$sd"
t_digest "$sd"

# Every directory made with mktemp -d is mode 0700 and under the test home (stage and, on Oracle, root work dirs).
for s in nezopt pi oracle; do
  good_cfg
  case "$s" in
    nezopt) run "$sd/install-ops-nezopt.sh" alerts ;;
    pi) run "$sd/install-ops-pi.sh" alerts ;;
    oracle) run "$sd/install-ops-oracle.sh" ;;
  esac
  [[ "$rc_out" == 0 ]] || fail "$s: install failed ($(cat "$tmp/out"))"
  grep -q "^mktemp-mode 700 $home/\.pokoin-stage\." "$LOG" || fail "$s: the staging directory is not mode 0700 under the home"
  ! grep '^mktemp-mode' "$LOG" | grep -vq "^mktemp-mode 700 $home/\.pokoin-" || fail "$s: a mktemp directory is not mode 0700 under the home"
done
grep -q "^mktemp-mode 700 $home/\.pokoin-root\." "$LOG" || fail "oracle: the root work directory is not mode 0700 under root's home"

# Oracle: the root step installs from its own copy, so a swap of the user-staged files after the copy changes nothing.
good_cfg
STUB_SWAP_AT_INSTALL=1 run "$sd/install-ops-oracle.sh"
[[ "$rc_out" == 0 ]] || fail "oracle: install failed ($(cat "$tmp/out"))"
[[ -e "$STUB_MARKER.swapped" ]] || fail "oracle: the swap was not modelled"
bin_sha="$(sha256sum "$tmp/dist/x86_64/pokoin-ops" | cut -d' ' -f1)"
ct_sha="$(sha256sum "$repo/deploy/ops/oracle/pokoin-cardtrader-daily-market-refresh.service.d-alerts.conf" | cut -d' ' -f1)"
grep -Eq "^installsrc $bin_sha $root_re/pokoin-ops\$" "$LOG" || fail "oracle: the installed binary is not the verified copy"
grep -Eq "^installsrc $ct_sha $root_re/ct-alerts.conf\$" "$LOG" || fail "oracle: the installed drop-in is not the verified copy"
! grep -Eq "^installsrc [0-9a-f]+ $stage_re/" "$LOG" || fail "oracle: installed from the user staging directory"

# mismatch_refused <label> [installs allowed]: refused with the short-prefix line, no value, nothing left behind,
# and no install call beyond the allowed count.
mismatch_refused() {
  [[ "$rc_out" != 0 ]] || fail "$1: a digest mismatch must fail the script"
  grep -Eq '^digest mismatch: expected [0-9a-f]{12}, got [0-9a-f]{12}$' "$tmp/out" || fail "$1: no digest mismatch line ($(cat "$tmp/out"))"
  [[ "$(grep -c '^install ' "$LOG")" == "${2:-0}" ]] || fail "$1: install ran after a digest mismatch"
  no_values "$1"
  no_stage_left "$1"
}
# One wrong digest at each place a verification happens.
t_sites_pi() {
  local d="$1" n
  for n in pokoin-ops pokoin-notify@.service pokoin-sentinel.service pokoin-sentinel.timer pokoin-digest.service \
           pokoin-digest.timer rust-job-alerts.conf watchdog-alerts.conf; do
    good_cfg; STUB_CORRUPT_ONLY="$n" run "$d/install-ops-pi.sh" alerts
    mismatch_refused "pi binary step ($n)"
    good_cfg; STUB_SWAP_AT_TESTF="$n" run "$d/install-ops-pi.sh" alerts
    mismatch_refused "pi units step ($n)" 1
  done
  for n in wal-g walspool-archive.sh pokoin-wal-push.service pokoin-wal-push.timer pokoin-basebackup.service pokoin-basebackup.timer; do
    good_cfg; printf 'MARKER_WALG=marker-walg\n' >"$etc/walg.env"
    STUB_CORRUPT_ONLY="$n" run "$d/install-ops-pi.sh" walg "$walg_bin" "$walg_sha"
    mismatch_refused "pi wal-g step ($n)"
  done
}
t_sites_oracle() {
  local d="$1" n
  for n in pokoin-ops pokoin-notify@.service ct-alerts.conf; do
    good_cfg; STUB_CORRUPT_ONLY="$n" run "$d/install-ops-oracle.sh"
    mismatch_refused "oracle key-check step ($n)"
    good_cfg; STUB_SWAP_AT_TESTF="$n" run "$d/install-ops-oracle.sh"
    mismatch_refused "oracle install step ($n)"
  done
}
t_sites_nezopt() {
  local d="$1" fn line n w i
  local -a names
  for fn in alerts pi-follow pi-hooks-live; do
    good_cfg; run "$d/install-ops-nezopt.sh" "$fn"
    names=()
    while read -r line; do
      read -ra w <<<"$line"
      for ((i = 1; i < ${#w[@]} - 1; i++)); do
        case "${w[i]}" in -D) ;; -m) i=$((i + 1)) ;; *) names+=("$(basename "${w[i]}")") ;; esac
      done
    done < <(grep '^install ' "$LOG")
    [[ "${#names[@]}" -gt 0 ]] || fail "nezopt $fn: no install calls to test"
    echo "nezopt $fn: ${#names[@]} staged files" >>"$tmp/sitecount"
    for n in "${names[@]}"; do
      good_cfg; STUB_CORRUPT_ONLY="$n" run "$d/install-ops-nezopt.sh" "$fn"
      [[ "$rc_out" != 0 ]] || fail "nezopt $fn ($n): a digest mismatch must fail the script"
      grep -Eq '^digest mismatch: expected [0-9a-f]{12}, got [0-9a-f]{12}$' "$tmp/out" || fail "nezopt $fn ($n): no digest mismatch line"
      ! grep -Eq "^install .* $stage_re/[0-9]+/$n( |\$)" "$LOG" || fail "nezopt $fn ($n): installed after a digest mismatch"
      no_values "nezopt $fn ($n)"
      no_stage_left "nezopt $fn ($n)"
    done
  done
}
t_sites_pi "$sd"
t_sites_oracle "$sd"
t_sites_nezopt "$sd"

# A newly created alerts.env names the two mail keys only in comments, so it defines neither key (key names only,
# never an address) and cannot shadow a later file. The template is captured from the ssh stub's stdin.
mkdir -p "$home/.config/pokoin"
echo 'RESEND_API_KEY=marker-key' >"$home/.config/pokoin/uptime-mail.env"
new_file_has_commented_keys() { # <label>
  local t="$tmp/template"
  grep -q '^# POKOIN_ALERT_MAIL_TO=$' "$LOG" || fail "$1: new alerts.env lacks the commented recipient key"
  grep -q '^# POKOIN_ALERT_MAIL_FROM=$' "$LOG" || fail "$1: new alerts.env lacks the commented sender key"
  grep -q '^# Required: the only place the alert recipient' "$LOG" || fail "$1: new alerts.env lacks the Required comment"
  ! grep -Eq '^[[:space:]]*(export +)?POKOIN_(ALERT_MAIL_(TO|FROM)|UPTIME_MAIL_TO)[[:space:]]*=' "$LOG" || fail "$1: new alerts.env defines a mail key"
  ! grep -Eq '[A-Za-z0-9]@[A-Za-z0-9-]+\.[a-z]{2,}' "$LOG" || fail "$1: an address was written"
  # The template, placed first in the file order, must not shadow keys set in a later file.
  grep -E '^(RESEND|POKOIN_HC|# )' "$LOG" >"$t"
  rm -rf "$tmp/sh"; mkdir -p "$tmp/sh/etc" "$tmp/sh/home/.config/pokoin"
  cp "$t" "$tmp/sh/etc/alerts.env"
  printf '%s\n' "POKOIN_ALERT_MAIL_FROM=marker-from-value" "POKOIN_ALERT_MAIL_TO=marker-to-value" >"$tmp/sh/home/.config/pokoin/alerts.env"
  ( lib; HOME="$tmp/sh/home" mail_keys_check "$tmp/sh/etc" ) >"$tmp/shout" 2>&1 || fail "$1: the new alerts.env shadows keys set in a later file"
}
good_cfg
STUB_NOFILE=1 run "$sd/install-ops-pi.sh" alerts
new_file_has_commented_keys pi
STUB_NOFILE=1 run "$sd/install-ops-oracle.sh"
new_file_has_commented_keys oracle

# --env-file replaces the default file list: no install script and no unit may pass it.
for s in nezopt pi oracle; do
  ! grep -q -e '--env-file' "$here/install-ops-$s.sh" || fail "$s: the installer passes --env-file"
done
if grep -rIn 'mail-config-check' "$repo/deploy" "$repo/scripts" --exclude=install-ops.test.sh | grep -e '--env-file'; then
  fail "a script or unit passes --env-file to mail-config-check"
fi

# ---- shell mail-key check (install-ops-lib.sh): dummy files in a temp dir, marker values, no real host file ----
# kc <etc-uptime-mail.env text|-> <etc-alerts.env text|-> [home-alerts.env text]: runs mail_keys_check against
# dummy files; $kc_rc is its status and $tmp/kcout its output. "-" means the file does not exist.
kc() {
  rm -rf "$tmp/kc"; mkdir -p "$tmp/kc/etc" "$tmp/kc/home/.config/pokoin"
  [[ "$1" == - ]] || printf '%s\n' "$1" >"$tmp/kc/etc/uptime-mail.env"
  [[ "$2" == - ]] || printf '%s\n' "$2" >"$tmp/kc/etc/alerts.env"
  [[ "${3:--}" == - ]] || printf '%s\n' "$3" >"$tmp/kc/home/.config/pokoin/alerts.env"
  set +e
  ( lib; HOME="$tmp/kc/home" mail_keys_check "$tmp/kc/etc" ) >"$tmp/kcout" 2>&1
  kc_rc=$?
  set -e
}
kc_ok() { kc "$@"; [[ "$kc_rc" == 0 ]] || fail "key check refused: $1 / $2 / ${3:--} ($(cat "$tmp/kcout"))"; }
kc_refused() { # <key name that must be named> then kc args
  local key="$1"; shift
  kc "$@"; [[ "$kc_rc" != 0 ]] || fail "key check passed: $1 / $2 / ${3:--}"
grep -q "missing: .*$key" "$tmp/kcout" || fail "key check did not name $key"
}
from=POKOIN_ALERT_MAIL_FROM; to=POKOIN_ALERT_MAIL_TO; fb=POKOIN_UPTIME_MAIL_TO
kc_ok - "$from=marker-from-value
$to=marker-to-value"
kc_refused $from - "$to=marker-to-value"                                  # sender missing
kc_refused $from - "$from=
$to=marker-to-value"                                                       # sender empty
kc_refused $from - "$from=\"\"
$to=marker-to-value"                                                       # sender empty, double quotes
kc_refused $from - "$from=''
$to=marker-to-value"                                                       # sender empty, single quotes
kc_refused $from - "$from=\"   \"
$to=marker-to-value"                                                       # sender blank inside quotes
kc_ok - "$from=marker-from-value
$fb=marker-fallback-value"                                                 # recipient only through the fallback key
kc_ok - "$from=marker-from-value" "$fb=marker-fallback-value"            # fallback in another file
kc_refused $to - "$from=marker-from-value"                                # recipient missing in both keys
kc_refused $to - "$from=marker-from-value
$to=
$fb="                                                                      # recipient empty in both keys
kc_ok - "$from=\"marker-from-value\"
$to='marker-to-value'"                                                     # quoted values
kc_ok - "export $from=marker-from-value
export $to=\"marker-to-value\""                                            # export form
kc_ok - "  $from = marker-from-value
$to  =  marker-to-value"                                                   # spaces around the key and the equals sign
kc_refused $from - "# $from=marker-from-value
$to=marker-to-value"                                                       # sender only in a comment
kc_refused $to - "$from=marker-from-value
#$to=marker-to-value
  # export $fb=marker-fallback-value"                                      # recipient only in comments
kc_refused $from - "XX$from=marker-from-value
${from}_SUFFIX=marker-from-value
$to=marker-to-value"                                                       # other keys that contain the name
kc_refused $from "$from=" "$from=marker-from-value
$to=marker-to-value"                                                       # the first file that defines a key decides
kc_ok "$from=marker-from-value" - "$to=marker-to-value"                  # keys spread over three files
kc_refused $from - "$from=
$from=marker-from-value
$to=marker-to-value"       # first line empty, a later line sets it: empty
kc_refused $from - "export $from=
export $from=marker-from-value
$to=marker-to-value"   # the same with export
kc_refused $from - "$from=''
$from=marker-from-value
$to=marker-to-value"     # the same with quotes
kc_refused $to - "$from=marker-from-value
$to=
$to=marker-to-value"       # recipient: first line empty, later set
kc_ok - "$from=marker-from-value
$from=
$to=marker-to-value"            # first line set, a later line empty: set
kc_refused $from "$from=" "$from=marker-from-value
$to=marker-to-value"    # empty in an earlier file, set in a later one
kc_refused $from - "export	$from=marker-from-value
$to=marker-to-value"   # export with a tab is not a definition for pokoin-ops
kc_refused $from - "$to=marker-to-value"
for p in etc/uptime-mail.env etc/alerts.env home/.config/pokoin/alerts.env; do
  grep -q "$tmp/kc/$p" "$tmp/kcout" || fail "refusal does not list $p"
done
! grep -q marker "$tmp/kcout" || fail "refusal printed a value"
kc_ok - "$from=marker-from-value
$to=marker-to-value"
! grep -q . "$tmp/kcout" || fail "a passing check printed something"
# The library reads values with grep -q only.
! grep -v '^[[:space:]]*#' "$here/install-ops-lib.sh" | grep grep | grep -vq 'grep -Eq' || fail "install-ops-lib.sh has a grep without -q"

# verify_staged: matching digests pass; a mismatch returns 1 and prints the two short prefixes only.
vs="$tmp/vs"; mkdir -p "$vs"; printf 'marker-content' >"$vs/a"; printf 'other-marker' >"$vs/b"
good_a="$(sha256sum "$vs/a" | cut -d' ' -f1)"; good_b="$(sha256sum "$vs/b" | cut -d' ' -f1)"
( lib; verify_staged "$vs" "a=$good_a" "b=$good_b" ) || fail "verify_staged refused matching digests"
set +e
( lib; verify_staged "$vs" "a=$good_a" "b=$good_a" ) >"$tmp/vsout" 2>&1; vs_rc=$?
set -e
[[ "$vs_rc" == 1 ]] || fail "verify_staged accepted a digest mismatch"
[[ "$(cat "$tmp/vsout")" == "digest mismatch: expected ${good_a:0:12}, got ${good_b:0:12}" ]] || fail "unexpected mismatch output: $(cat "$tmp/vsout")"
set +e
( lib; verify_staged "$vs" "missing=$good_a" ) >/dev/null 2>&1; vs_rc=$?
set -e
[[ "$vs_rc" == 1 ]] || fail "verify_staged accepted a missing file"

# A digest that is not exactly 64 lowercase hex characters is refused by name, never by value; an empty one too,
# even when the file is missing.
bad_digest() { # <label> <item>
  set +e
  ( lib; verify_staged "$vs" "$2" ) >"$tmp/vsout" 2>&1; vs_rc=$?
  set -e
  [[ "$vs_rc" == 1 ]] || fail "verify_staged accepted $1"
  [[ "$(cat "$tmp/vsout")" == "invalid digest for ${2%%=*}" ]] || fail "unexpected output for $1: $(cat "$tmp/vsout")"
}
bad_digest "an empty digest" "a="
bad_digest "an empty digest for a missing file" "missing="
bad_digest "an uppercase digest" "a=${good_a^^}"
bad_digest "a short digest" "a=${good_a:0:63}"
bad_digest "a long digest" "a=${good_a}0"
bad_digest "a non-hex digest" "a=${good_a:0:63}g"
bad_digest "an item without a digest" "a"
# copy_verified checks the copy: a matching file is copied and passes, a changed one is refused.
cv="$tmp/cv"; rm -rf "$cv"; mkdir -p "$cv/from" "$cv/to"; cp "$vs/a" "$cv/from/a"
( lib; copy_verified "$cv/from" "$cv/to" "a=$good_a" ) || fail "copy_verified refused a matching file"
[[ "$(sha256sum "$cv/to/a" | cut -d' ' -f1)" == "$good_a" ]] || fail "copy_verified did not copy"
echo x >>"$cv/from/a"
if ( lib; copy_verified "$cv/from" "$cv/to" "a=$good_a" ) >/dev/null 2>&1; then fail "copy_verified accepted a changed file"; fi

# ---- mutation proofs: a temp copy of the scripts with one guard removed must fail the matching test ----
# caught <label> <test function> <scripts dir>: the test must fail on this copy; its FAIL line is shown.
caught() {
  local out
  if out="$( ("$2" "$3") 2>&1 )"; then fail "mutation not caught: $1"; fi
  echo "mutation caught ($1): $out"
}
ctl="$(copy_scripts control)"
( t_marker "$ctl" && t_digest "$ctl" && t_sites_pi "$ctl" && t_sites_oracle "$ctl" ) || fail "the unmutated copy fails its tests"

# Putting the staged-binary execution back (Pi: run on the target from the staging directory; nezopt: run the binary).
m="$(copy_scripts exec-pi)"
perl -0pi -e 's/(  stage_put "\$bin" pokoin-ops\n)/$1  "\${SSH[@]}" "\$stage\/pokoin-ops" mail-config-check || true\n/' "$m/install-ops-pi.sh"
grep -q 'stage/pokoin-ops" mail-config-check' "$m/install-ops-pi.sh" || fail "the exec-pi mutation did not apply"
caught "staged binary executed on the Pi" t_marker "$m"
m="$(copy_scripts exec-nezopt)"
perl -0pi -e 's/(  mail_keys_check \|\| die [^\n]*\n)/$1  "\$bin" mail-config-check || true\n/' "$m/install-ops-nezopt.sh"
grep -q 'bin" mail-config-check' "$m/install-ops-nezopt.sh" || fail "the exec-nezopt mutation did not apply"
caught "binary executed by the nezopt installer" t_marker "$m"

# Dropping the digest comparison.
m="$(copy_scripts no-digest)"
perl -0pi -e 's/if \[\[ "\$got" != "\$want" \]\]; then/if false; then/' "$m/install-ops-lib.sh"
grep -q 'if false; then' "$m/install-ops-lib.sh" || fail "the no-digest mutation did not apply"
caught "digest comparison dropped" t_digest "$m"

# Dropping the verify before the Pi units install, and before the Oracle install.
m="$(copy_scripts no-verify-pi-units)"
perl -0pi -e 'my $c = 0; s/verify_staged "\$stage" "\$\@"/++$c == 2 ? ":" : $&/ge' "$m/install-ops-pi.sh"
# shellcheck disable=SC2016  # the pattern is literal text
[[ "$(grep -c 'verify_staged "\$stage"' "$m/install-ops-pi.sh")" == 2 ]] || fail "the no-verify-pi-units mutation did not apply"
caught "verify dropped before the Pi units install" t_sites_pi "$m"
m="$(copy_scripts no-verify-oracle)"
perl -0pi -e 'my $c = 0; my $r = q{cp "$stage"/* "$work"/}; s/copy_verified "\$stage" "\$work" "\$\@"/++$c == 2 ? $r : $&/ge' "$m/install-ops-oracle.sh"
# shellcheck disable=SC2016  # the pattern is literal text
grep -q 'cp "\$stage"/\* "\$work"/' "$m/install-ops-oracle.sh" || fail "the no-verify-oracle mutation did not apply"
caught "verify dropped before the Oracle install" t_sites_oracle "$m"

cat "$tmp/sitecount"
echo "install-ops: ok"
