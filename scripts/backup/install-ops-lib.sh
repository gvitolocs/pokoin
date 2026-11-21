# shellcheck shell=bash
# Functions shared by install-ops-{nezopt,pi,oracle}.sh. The nezopt installer sources this file; the Pi
# and Oracle installers send it on stdin to the target's privileged shell ahead of the step's own
# commands. It is not run on its own.

# verify_staged <dir> <name=sha256>...: compares the sha256 of each <dir>/<name> with the value computed
# on the build side. An expected value that is not 64 lowercase hex characters (an empty one included) is
# refused and names the item. A mismatch prints the two short prefixes and nothing else. Both return 1.
verify_staged() {
  local dir="$1" item name want got
  shift
  for item in "$@"; do
    name="${item%%=*}"
    want="${item#*=}"
    if [[ ! "$want" =~ ^[0-9a-f]{64}$ ]]; then
      echo "invalid digest for $name" >&2
      return 1
    fi
    got="$(sha256sum "$dir/$name" 2>/dev/null | cut -d' ' -f1)"
    if [[ "$got" != "$want" ]]; then
      echo "digest mismatch: expected ${want:0:12}, got ${got:0:12}" >&2
      return 1
    fi
  done
}

# copy_verified <from dir> <to dir> <name=sha256>...: copies each named file into <to dir>, then verifies
# the copies (not the originals) against the digests. Install only from <to dir> afterwards.
copy_verified() {
  local from="$1" to="$2" item
  shift 2
  for item in "$@"; do
    cp -- "$from/${item%%=*}" "$to/${item%%=*}" 2>/dev/null || true
  done
  verify_staged "$to" "$@"
}

# mail_keys_check [etc dir]: the host must have a mail sender and a mail recipient configured. It reads the
# files pokoin-ops reads (tools/pokoin-ops/src/env.rs default_files(); the list is the same for the nezopt,
# Pi and Oracle roles), in the same order:
#   <etc>/uptime-mail.env  <etc>/alerts.env  $HOME/.config/pokoin/uptime-mail.env  $HOME/.config/pokoin/alerts.env
# <etc> is /etc/pokoin (the optional argument is for tests). As in pokoin-ops, the first file that defines a
# key decides it, and within that file the first defining line decides: a definition is KEY=value or
# export KEY=value, with or without quotes; an empty value makes the key missing, and a later line in the
# same file does not change that. A key named only in a comment is missing. grep is used with -q or in a
# pipe into grep -q: no value is read out or printed.
# Needs POKOIN_ALERT_MAIL_FROM, and POKOIN_ALERT_MAIL_TO or else POKOIN_UPTIME_MAIL_TO.
# On failure it prints the missing key names and the paths checked, and returns 1.
mail_keys_check() {
  local etc="${1:-/etc/pokoin}" f looked="" problems=0
  local -a files=("$etc/uptime-mail.env" "$etc/alerts.env"
                  "$HOME/.config/pokoin/uptime-mail.env" "$HOME/.config/pokoin/alerts.env")
  for f in "${files[@]}"; do looked+="${looked:+, }$f"; done

  mail_key_is_set() { # KEY
    local key="$1" file def
    def="^[[:space:]]*(export +)?${key}[[:space:]]*="
    for file in "${files[@]}"; do
      [[ -r "$file" ]] || continue
      if grep -Eq "$def" "$file"; then
        grep -m1 -E "$def" "$file" | grep -Eq "${def}[[:space:]]*(\"[[:space:]]*[^\"[:space:]]|'[[:space:]]*[^'[:space:]]|[^\"'[:space:]])"
        return
      fi
    done
    return 1
  }

  if ! mail_key_is_set POKOIN_ALERT_MAIL_FROM; then
    echo "missing: POKOIN_ALERT_MAIL_FROM (looked in: $looked)" >&2
    problems=1
  fi
  if ! mail_key_is_set POKOIN_ALERT_MAIL_TO && ! mail_key_is_set POKOIN_UPTIME_MAIL_TO; then
    echo "missing: POKOIN_ALERT_MAIL_TO or POKOIN_UPTIME_MAIL_TO (looked in: $looked)" >&2
    problems=1
  fi
  [[ "$problems" == 0 ]]
}
