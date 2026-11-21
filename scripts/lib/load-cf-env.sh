# shellcheck shell=bash
# Sourced by the publish and operator scripts: loads the Cloudflare deploy credentials from
# ${HOME}/.config/pokoin/cloudflare.env into the environment whenever that file is readable and LANE_WORKER is unset;
# a value in the file replaces one the calling shell already exported.
#
# - does nothing when LANE_WORKER is set, or when the file is not a readable regular file
# - POKOIN_CF_ENV_FILE is for tests: it picks which file is read, and nothing else
# - returns 0 in every case; writes nothing to stdout or stderr itself, and the file's own output is discarded
#   (a caller that runs with `set -v` still has bash echo the lines of this file as it reads them)
# - restores the caller's `set -o` options (errexit and verbose included) and bash `shopt` options as it found them,
#   whatever the file changed
# - does not restore umask, IFS, traps, the working directory, or the variables the file assigns (they are the point
#   of the file); an `exit` inside the file ends the caller
# - keeps its option snapshot in _load_cf_env_snapshot, a plain variable that is unset again before returning; a file
#   is sourced in this function's scope, so a file that assigns that name changes what gets restored, and one that
#   makes it read-only leaves the name set (the function still returns 0)

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
  _load_cf_env_snapshot=$(
    set +o
    shopt -p
  )
  # a command substitution reports errexit and verbose as off, so both are added by hand
  case "$-" in *e*) _load_cf_env_snapshot="$_load_cf_env_snapshot"$'\n''set -o errexit' ;; esac
  case "$-" in *v*) _load_cf_env_snapshot="$_load_cf_env_snapshot"$'\n''set -o verbose' ;; esac
  set +e +u
  set -a
  # shellcheck source=/dev/null
  { . "$_f" || true; } > /dev/null 2>&1
  { eval "$_load_cf_env_snapshot"; } > /dev/null 2>&1 || true
  unset _load_cf_env_snapshot > /dev/null 2>&1 || true
  return 0
}

load_cf_env || true
