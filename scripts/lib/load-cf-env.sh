# shellcheck shell=bash
# Sourced by the publish and operator scripts: loads the Cloudflare deploy credentials from
# ${HOME}/.config/pokoin/cloudflare.env into the environment whenever that file is readable and LANE_WORKER is unset;
# a value in the file replaces one the calling shell already exported.
#
# - does nothing when LANE_WORKER is set, or when the file is not a readable regular file
# - POKOIN_CF_ENV_FILE is for tests: it picks which file is read, and nothing else
# - prints nothing, returns 0 in every case, and leaves the caller's set -e, set -u and set -a state as it found it

load_cf_env() {
  local _f _had_e=0 _had_u=0 _had_a=0
  [ -z "${LANE_WORKER:-}" ] || return 0
  if [ -n "${POKOIN_CF_ENV_FILE:-}" ]; then
    _f="$POKOIN_CF_ENV_FILE"
  elif [ -n "${HOME:-}" ]; then
    _f="$HOME/.config/pokoin/cloudflare.env"
  else
    return 0
  fi
  if [ ! -f "$_f" ] || [ ! -r "$_f" ]; then return 0; fi
  case "$-" in *e*) _had_e=1 ;; esac
  case "$-" in *u*) _had_u=1 ;; esac
  case "$-" in *a*) _had_a=1 ;; esac
  set +e +u
  set -a
  # shellcheck source=/dev/null
  . "$_f" > /dev/null 2>&1 || true
  if [ "$_had_a" = 0 ]; then set +a; fi
  if [ "$_had_u" = 1 ]; then set -u; fi
  if [ "$_had_e" = 1 ]; then set -e; fi
  return 0
}

load_cf_env || true
