# shellcheck shell=bash
# Sourced by the publish and operator scripts: loads the Cloudflare deploy credentials from
# ${HOME}/.config/pokoin/cloudflare.env into the environment whenever that file is readable and LANE_WORKER is unset;
# a value in the file replaces one the calling shell already exported.
#
# - does nothing when LANE_WORKER is set, or when the file is not a readable regular file
# - POKOIN_CF_ENV_FILE is for tests: it picks which file is read, and nothing else
# - prints nothing and returns 0 in every case
# - restores the caller's `set -o` options and bash `shopt` options as it found them, whatever the file changed
# - does not restore umask, IFS, traps, the working directory, or the variables the file assigns (they are the point
#   of the file); an `exit` inside the file ends the caller

load_cf_env() {
  local _f
  [ -z "${LANE_WORKER:-}" ] || return 0
  if [ -n "${POKOIN_CF_ENV_FILE:-}" ]; then
    _f="$POKOIN_CF_ENV_FILE"
  elif [ -n "${HOME:-}" ]; then
    _f="$HOME/.config/pokoin/cloudflare.env"
  else
    return 0
  fi
  if [ ! -f "$_f" ] || [ ! -r "$_f" ]; then return 0; fi
  _cf_opts=$(
    set +o
    shopt -p
  )
  # a command substitution does not report errexit, so it is added by hand
  case "$-" in *e*) _cf_opts="$_cf_opts"$'\n''set -o errexit' ;; esac
  set +e +u
  set -a
  # shellcheck source=/dev/null
  . "$_f" > /dev/null 2>&1 || true
  { eval "$_cf_opts"; } 2> /dev/null || true
  unset _cf_opts
  return 0
}

load_cf_env || true
