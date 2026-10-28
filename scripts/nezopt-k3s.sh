#!/usr/bin/env bash
# Pokoin Pi overflow on nezopt: k3s running inside Docker (container pokoin-k3s),
# so nothing is installed on the host and `down` removes it cleanly.
#
#   scripts/nezopt-k3s.sh up             # start / create the k3s container
#   scripts/nezopt-k3s.sh sync           # Pi Rust release (x86 build) + env + sitemaps → nezopt, restart pods if changed
#   scripts/nezopt-k3s.sh apply          # kubectl apply infra/k3s/pokoin-overflow.yaml + pokoin-security.yaml
#   scripts/nezopt-k3s.sh network        # Docker network, DB attachments, scan + Hermes bridges (idempotent)
#   scripts/nezopt-k3s.sh secret         # only rebuild the env secrets (pods, CronJobs) from $POKOIN_ENV_SOURCE
#   scripts/nezopt-k3s.sh video          # additive poko-video mirror from the Pi into the k3s CDN root (never deletes)
#   scripts/nezopt-k3s.sh env-diff       # key names that differ between the Pi process env and the Pi env file
#   scripts/nezopt-k3s.sh reindex        # one-off full Redis Search rebuild (first run / repair)
#   scripts/nezopt-k3s.sh status         # nodes, pods, HPA, overflow health
#   scripts/nezopt-k3s.sh install        # user timer: `sync` backstop (the Pi's release hook triggers it; docs/NEZOPT_OVERFLOW.md)
#   scripts/nezopt-k3s.sh down           # stop the container (data kept in ~/pokoin-overflow)
#
# See docs/NEZOPT_OVERFLOW.md. Cloudflare's load balancer sends part of
# api.pokoin.com here through the in-cluster cloudflared; pods run the same
# native Rust binary as the Pi (no Node).
set -euo pipefail

K3S_IMAGE="${K3S_IMAGE:-rancher/k3s:v1.36.4-k3s1}"
CONTAINER="${K3S_CONTAINER:-pokoin-k3s}"
BASE="${POKOIN_OVERFLOW_HOME:-$HOME/pokoin-overflow}"
# Leftover card-image mirror served as the cdn.pokoin.com second origin.
CDN_OBJECTS="${POKOIN_CDN_OBJECTS:-$HOME/data/pokoin-leftovers/objects}"
PI="${PI_HOST:-pi-home}"
PI_UNIT="${PI_RUST_UNIT:-pokoin-rust-api}"
# Builds come from this repository's objects (a detached worktree, never a checkout someone works in).
REPO="${POKOIN_REPO:-$HOME/Projects/Startup/Pokoin/pokoin-web}"
NS=pokoin-overflow
# Least-privilege role passwords (<role>.pw, mode 600); see docs/SECURITY_HARDENING.md.
PG_ROLES_DIR="${POKOIN_PG_ROLES_DIR:-$HOME/secrets/pokoin-pg-roles}"
# UFW drops container → host traffic, so pods reach the writer Postgres
# container directly on a user-defined Docker network with fixed addresses.
NET=pokoin-overflow
NET_SUBNET=172.31.250.0/24
WRITER_CONTAINER="${WRITER_CONTAINER:-pokoin-marketplace-postgres-15t}"
WRITER_NET_IP=172.31.250.10
TCGCSV_CONTAINER="${TCGCSV_CONTAINER:-tcgprices-postgres-15t}"
TCGCSV_NET_IP=172.31.250.11
K3S_NET_IP=172.31.250.20
# Host loopback services pods reach through socat bridges on $NET (see host_bridge; .14 is
# pokoin-honcho-bridge, made by hand outside this script):
# Scan Connect → the pokoin-scanner GPU recognition worker on :8098 (nezopt-cardscan), and
# Hermes (Poko chat) → oracle-poko-tunnel.service on :18789.
SCAN_BRIDGE_CONTAINER="${SCAN_BRIDGE_CONTAINER:-pokoin-scan-bridge}"
SCAN_BRIDGE_IP=172.31.250.12
SCAN_BRIDGE_PORT=18151
SCAN_HOST_PORT=8098
HERMES_BRIDGE_CONTAINER="${HERMES_BRIDGE_CONTAINER:-pokoin-hermes-bridge}"
HERMES_BRIDGE_IP=172.31.250.13
HERMES_PORT=18789
# The Pi's own CDN (127.0.0.1:18081 there) through pokoin-pi-cdn-tunnel.service on host 127.0.0.1:18181:
# POKOIN_CDN_FALLBACK_ORIGIN of the pods, so a file that has not reached the mirror yet is served from the Pi.
PI_CDN_BRIDGE_CONTAINER="${PI_CDN_BRIDGE_CONTAINER:-pokoin-pi-cdn-bridge}"
PI_CDN_BRIDGE_IP=172.31.250.15
PI_CDN_PORT=18181
# Where the API env comes from (sync_secret):
#   pi-proc    /proc/<MainPID>/environ of the running Pi service (the source until 2026-10-28)
#   pi-file    the Pi's EnvironmentFile, parsed like systemd does (default; same secret hash as pi-proc)
#   infisical  $ENV_REF through the Infisical broker, the source the Pi renders its env file from
ENV_SOURCE="${POKOIN_ENV_SOURCE:-pi-file}"
ENV_REF="${POKOIN_ENV_REF:-secret://pokoin-runtime/prod#POKOIN_API_ENV}"
BROKER_TOKEN_FILE="${POKOIN_BROKER_TOKEN_FILE:-$HOME/.config/infisical-mcp/svc-pokoin-overflow-sync.token}"
PI_ENV_FILE="${PI_ENV_FILE:-/srv/pokoin/rust/pokoin-api.env}"
# Stamps the Pi's notify hook touches (deploy/ops/nezopt-user/pokoin-pi-hook) and the applied env hash.
STATE="${POKOIN_OVERFLOW_STATE:-$HOME/.local/state/pokoin-overflow}"
VIDEO_SRC="${POKO_VIDEO_SRC:-/srv/pokoin/card-images/objects/poko-video/}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$HERE/infra/k3s/pokoin-overflow.yaml"
[[ -f "$MANIFEST" ]] || MANIFEST="$(cd "$HERE/.." && pwd)/infra/k3s/pokoin-overflow.yaml"

say() { echo "== $*"; }
die() { echo "nezopt-k3s: $*" >&2; exit 1; }
kc() { docker exec -i "$CONTAINER" kubectl "$@"; }

up() {
  mkdir -p "$BASE/k3s" "$BASE/data/rust/releases" "$BASE/data/seo" "$BASE/data/extension" "$BASE/data/meili"
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    docker start "$CONTAINER" >/dev/null
  else
    say "create $CONTAINER ($K3S_IMAGE)"
    docker run -d --name "$CONTAINER" --hostname nezopt-k3s --privileged --restart unless-stopped \
      --tmpfs /run --tmpfs /var/run \
      -v "$BASE/k3s:/var/lib/rancher/k3s" \
      -v "$BASE/data:/srv/pokoin-overflow" \
      -v "$CDN_OBJECTS:/srv/pokoin-cdn:ro" \
      "$K3S_IMAGE" server --disable traefik --disable servicelb \
      --write-kubeconfig-mode 600 --secrets-encryption --resolv-conf /var/lib/rancher/k3s/upstream-resolv.conf --node-name nezopt \
      --kubelet-arg=eviction-hard=imagefs.available\<20Gi,nodefs.available\<20Gi \
      --kubelet-arg=eviction-minimum-reclaim=imagefs.available=2Gi,nodefs.available=2Gi >/dev/null
  fi
  timeout 180 bash -c "until docker exec $CONTAINER kubectl get nodes 2>/dev/null | grep -q ' Ready'; do sleep 3; done" \
    || die "k3s did not become Ready"
  network
  say "k3s ready"
}

# UFW drops container → host traffic, so each bridge is a privileged socat
# container on $NET that enters the host network namespace per connection.
# Idempotent: an existing bridge is only started if stopped, never recreated.
#   host_bridge <container> <bridge ip> <listen port> <host loopback port>
host_bridge() {
  local name="$1" ip="$2" port="$3" host_port="$4"
  if docker inspect "$name" >/dev/null 2>&1; then
    [[ "$(docker inspect -f '{{.State.Running}}' "$name")" == true ]] \
      || docker start "$name" >/dev/null
    return 0
  fi
  docker run -d --name "$name" --restart unless-stopped --privileged --pid host \
    --network "$NET" --ip "$ip" alpine:3.20 sh -c \
    "apk add --no-cache socat >/dev/null && printf '%s\n' '#!/bin/sh' 'exec nsenter -t 1 -n socat STDIO TCP:127.0.0.1:$host_port' > /bridge.sh && chmod +x /bridge.sh && exec socat TCP-LISTEN:$port,fork,reuseaddr,bind=$ip EXEC:/bridge.sh" \
    >/dev/null
}

# SCAN_PRIMARY_URL / SCAN_FALLBACK_URL in the manifest.
scan_bridge() { host_bridge "$SCAN_BRIDGE_CONTAINER" "$SCAN_BRIDGE_IP" "$SCAN_BRIDGE_PORT" "$SCAN_HOST_PORT"; }
# POKO_CHAT_URL / POKONTACT_SERVICE_URL, rewritten to this bridge by sync_secret.
hermes_bridge() { host_bridge "$HERMES_BRIDGE_CONTAINER" "$HERMES_BRIDGE_IP" "$HERMES_PORT" "$HERMES_PORT"; }
# POKOIN_CDN_FALLBACK_ORIGIN in the manifest.
pi_cdn_bridge() { host_bridge "$PI_CDN_BRIDGE_CONTAINER" "$PI_CDN_BRIDGE_IP" "$PI_CDN_PORT" "$PI_CDN_PORT"; }

network() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet "$NET_SUBNET" "$NET" >/dev/null
  local attached
  attached="$(docker network inspect "$NET" --format '{{range .Containers}}{{.Name}} {{end}}')"
  [[ " $attached " == *" $WRITER_CONTAINER "* ]] || docker network connect --ip "$WRITER_NET_IP" "$NET" "$WRITER_CONTAINER"
  [[ " $attached " == *" $CONTAINER "* ]] || docker network connect --ip "$K3S_NET_IP" "$NET" "$CONTAINER"
  if docker inspect "$TCGCSV_CONTAINER" >/dev/null 2>&1; then
    [[ " $attached " == *" $TCGCSV_CONTAINER "* ]] || docker network connect --ip "$TCGCSV_NET_IP" "$NET" "$TCGCSV_CONTAINER"
  fi
  scan_bridge
  hermes_bridge
  pi_cdn_bridge
}

# EnvironmentFile text on stdin → NUL-separated KEY=VALUE rows, as systemd parses it:
# `#`/`;` comments, whitespace trimmed around unquoted values, "double" quotes with
# backslash escapes, 'single' quotes literal, a trailing backslash continues the line.
envfile_rows() {
  python3 -c '
import re, sys
text = sys.stdin.read()
out = []
i, n = 0, len(text)
while i < n:
    while i < n and text[i] in " \t\r\n":
        i += 1
    if i >= n:
        break
    if text[i] in "#;":
        while i < n and text[i] != "\n":
            i += 1
        continue
    m = re.compile(r"(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=").match(text, i)
    if not m:
        while i < n and text[i] != "\n":
            i += 1
        continue
    key, i = m.group(1), m.end()
    while i < n and text[i] in " \t":
        i += 1
    value = []
    while i < n and text[i] != "\n":
        c = text[i]
        if c == "\"":
            i += 1
            while i < n and text[i] != "\"":
                if text[i] == "\\" and i + 1 < n:
                    i += 1
                    if text[i] != "\n":
                        value.append(text[i])
                else:
                    value.append(text[i])
                i += 1
            i += 1
        elif c == "\x27":
            i += 1
            while i < n and text[i] != "\x27":
                value.append(text[i])
                i += 1
            i += 1
        elif c == "\\" and i + 1 < n:
            i += 1
            if text[i] != "\n":
                value.append(text[i])
            i += 1
        else:
            value.append(c)
            i += 1
    raw = "".join(value).rstrip(" \t\r")
    out.append(f"{key}={raw}")
sys.stdout.write("".join(row + "\0" for row in out))
'
}

# NUL-separated KEY=VALUE rows of the API environment, from $ENV_SOURCE. The Pi's
# unit-level Environment= keys that pods use (only RUST_LOG today) only come with pi-proc;
# the secret builder fills in the same default.
env_rows() {
  case "$ENV_SOURCE" in
    pi-proc) ssh "$PI" "pid=\$(systemctl show -p MainPID --value $PI_UNIT); [ \"\$pid\" -gt 0 ] && cat /proc/\$pid/environ" ;;
    pi-file) ssh "$PI" "cat $PI_ENV_FILE" | envfile_rows ;;
    # Inside `infisical-broker exec` (see sync_secret): the value is only in this process tree.
    infisical-child) printf '%s' "${POKOIN_API_ENV:?POKOIN_API_ENV not injected}" | envfile_rows ;;
    *) die "POKOIN_ENV_SOURCE=$ENV_SOURCE: expected pi-proc, pi-file or infisical" ;;
  esac
}

# The k8s secrets pokoin-api-env and pokoin-jobs-env from the API environment. They are
# applied only when their content hash (annotation pokoin.com/env-sha256) changes, and
# $STATE/env.changed tells sync() to roll the pods.
sync_secret() {
  mkdir -p "$STATE"
  rm -f "$STATE/env.changed"
  if [[ "$ENV_SOURCE" == infisical ]]; then
    # The broker injects POKOIN_API_ENV into the child only; the value never reaches argv or stdout.
    [[ -r "$BROKER_TOKEN_FILE" ]] || die "no broker token $BROKER_TOKEN_FILE (docs/NEZOPT_OVERFLOW.md, Secrets)"
    infisical-broker exec --token-file "$BROKER_TOKEN_FILE" --env "POKOIN_API_ENV=$ENV_REF" -- \
      env POKOIN_ENV_SOURCE=infisical-child "$HERE/$(basename "$0")" _secret
    return
  fi
  apply_secret
}

apply_secret() {
  local current manifest
  current="$(kc -n "$NS" get secret pokoin-api-env -o jsonpath='{.metadata.annotations.pokoin\.com/env-sha256}' 2>/dev/null || true)"
  manifest="$(env_rows | python3 -c '
import base64, json, sys
env = [row.decode() for row in sys.stdin.buffer.read().split(b"\0") if row]
if not any(row.startswith("MARKETPLACE_DATABASE_URL=") for row in env):
    sys.exit("Pi Rust service environment not readable (is it running?)")
skip = {
    # systemd / login session
    "PATH", "HOME", "LANG", "LOGNAME", "USER", "SHELL", "INVOCATION_ID", "JOURNAL_STREAM",
    "SYSTEMD_EXEC_PID", "MEMORY_PRESSURE_WATCH", "MEMORY_PRESSURE_WRITE", "NOTIFY_SOCKET",
    # never: it would switch off certificate checks for outbound TLS
    "NODE_TLS_REJECT_UNAUTHORIZED",
    # Pi-only listeners, paths and roles; pods pin their own values
    "ORACLE_API_HOST", "POKOIN_TRUSTED_PROXY_CIDRS", "POKOIN_RUST_BIND", "POKOIN_EDGE_BIND",
    "POKOIN_CDN_BIND", "POKOIN_CT_DEALS_BIND", "POKOIN_CDN_ROOT", "POKOIN_CDN_NAME",
    "POKOIN_CDN_FALLBACK_ORIGIN", "POKOIN_SEO_DIR", "CT_DEALS_ROOT", "POKOIN_LISTING_SYNC_WORKER",
    # POKOIN_API_SERVICE_NAME stays: pods are the same public API as the Pi
    # (pokoin-oracle-api), which keeps e.g. the non-Pokemon game ingest guard on.
    "POKOIN_RUST_RELEASE", "MEILI_HOST",
}
data = {}
for row in env:
    key, _, value = row.partition("=")
    if key and key not in skip and not key.startswith("VALKEY_"):
        data[key] = base64.b64encode(value.encode()).decode()
# From the Environment= of the Pi unit, so only pi-proc sees it.
data.setdefault("RUST_LOG", base64.b64encode(b"info").decode())
# Pi Redis is loopback :6380. Overflow uses its own Redis service.
data["REDIS_HOST"] = base64.b64encode(b"redis.pokoin-overflow.svc.cluster.local").decode()
data["REDIS_PORT"] = base64.b64encode(b"6379").decode()
# Same writer database, reached on the overflow Docker network (see NET).
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

PG_CA = "/etc/pokoin/pg-ca/ca.crt"  # secret pokoin-pg-ca, mounted in every DB pod

def verified_query(query):
    # TLS with full certificate + host verification against the Pokoin PG CA.
    rows = [(k, v) for k, v in parse_qsl(query, keep_blank_values=True)
            if k not in {"sslmode", "sslrootcert", "uselibpqcompat"}]
    return urlencode(rows + [("uselibpqcompat", "true"), ("sslmode", "verify-full"), ("sslrootcert", PG_CA)])

def point_loopback_at(value, host):
    parts = urlsplit(value)
    if (parts.hostname or "") not in {"127.0.0.1", "localhost", "::1"}:
        return value
    user = parts.netloc.rsplit("@", 1)[0] if "@" in parts.netloc else ""
    netloc = f"{user}@{host}" if user else host
    return urlunsplit(parts._replace(netloc=netloc, query=verified_query(parts.query)))

writer = base64.b64decode(data.get("MARKETPLACE_WRITER_DATABASE_URL", "")).decode()
if writer:
    parts = urlsplit(writer)
    netloc = parts.netloc.rsplit("@", 1)
    host = f"{sys.argv[1]}:5432"
    netloc = f"{netloc[0]}@{host}" if len(netloc) == 2 else host
    data["MARKETPLACE_OVERFLOW_DATABASE_URL"] = base64.b64encode(
        urlunsplit(parts._replace(netloc=netloc, query=verified_query(parts.query))).encode()).decode()
    # Writes too: the Pi LAN writer URL times out from pods (UFW), which
    # surfaced as "Scan service error." on Scan Connect overflow requests.
    data["MARKETPLACE_WRITER_DATABASE_URL"] = data["MARKETPLACE_OVERFLOW_DATABASE_URL"]
    # Pi game URLs are the localhost SSH tunnel. databaseUrlForGame prefers
    # those explicit env vars, so a set desk for any other TCG connects to
    # 127.0.0.1:5432 inside the pod and the page returns 503.
    writer_host = f"{sys.argv[1]}:5432"
    for key, encoded in list(data.items()):
        if key in {"MARKETPLACE_DATABASE_URL", "MARKETPLACE_NAME_SEARCH_DATABASE_URL"} or key.endswith("_MARKETPLACE_DATABASE_URL"):
            raw = base64.b64decode(encoded).decode()
            data[key] = base64.b64encode(point_loopback_at(raw, writer_host).encode()).decode()
# The Pi uses a localhost SSH tunnel; overflow pods reach the independent
# quote database directly on the private Docker network instead.
quotes = base64.b64decode(data.get("TCGCSV_DATABASE_URL", "")).decode()
if quotes:
    parts = urlsplit(quotes)
    netloc = parts.netloc.rsplit("@", 1)
    host = f"{sys.argv[2]}:5432"
    netloc = f"{netloc[0]}@{host}" if len(netloc) == 2 else host
    data["TCGCSV_DATABASE_URL"] = base64.b64encode(
        urlunsplit(parts._replace(netloc=netloc)).encode()).decode()
# The Pi reaches Hermes through its own localhost SSH tunnel; overflow pods reach the
# same Hermes through the hermes bridge on the overflow Docker network.
for key in ("POKO_CHAT_URL", "POKONTACT_SERVICE_URL"):
    raw = base64.b64decode(data.get(key, "")).decode()
    parts = urlsplit(raw)
    if raw and (parts.hostname or "") in {"127.0.0.1", "localhost", "::1"}:
        data[key] = base64.b64encode(urlunsplit(parts._replace(netloc=sys.argv[3])).encode()).decode()
# Least-privilege roles (docs/SECURITY_HARDENING.md): every URL here reaches the
# nezopt writer, so pods log in as pokoin_api_write (reads and writes, one pool)
# and the CronJobs (secret pokoin-jobs-env) as pokoin_jobs. The read URLs of the Pi
# URLs carry pokoin_api_read, which the writer rejects. Without the password
# files both secrets keep the login of the Pi, as before.
from pathlib import Path
from urllib.parse import quote

def role_password(name):
    path = Path(sys.argv[4]) / f"{name}.pw"
    return path.read_text().strip() if path.is_file() else ""

def writer_keys(table):
    return [k for k in table if k != "TCGCSV_DATABASE_URL"
            and "MARKETPLACE" in k and k.endswith("DATABASE_URL")]

def with_login(value, user, password):
    parts = urlsplit(value)
    host = parts.netloc.rsplit("@", 1)[-1]
    return urlunsplit(parts._replace(netloc=f"{quote(user, safe="")}:{quote(password, safe="")}@{host}"))

def logins(table, user):
    password = role_password(user)
    out = dict(table)
    if password:
        for key in writer_keys(out):
            out[key] = base64.b64encode(with_login(base64.b64decode(out[key]).decode(), user, password).encode()).decode()
    return out

api = logins(data, "pokoin_api_write")
jobs = logins(data, "pokoin_jobs")
for name, table in (("pokoin_api_write", api), ("pokoin_jobs", jobs)):
    for key in writer_keys(table):
        if urlsplit(base64.b64decode(table[key]).decode()).username == "pokoin_api_read":
            sys.exit(f"{key} logs in as pokoin_api_read, which the writer rejects: "
                     f"create {sys.argv[4]}/{name}.pw first")

import hashlib
digest = hashlib.sha256(json.dumps([api, jobs], sort_keys=True).encode()).hexdigest()

def secret(name, table):
    return {"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
            "metadata": {"name": name, "namespace": "pokoin-overflow",
                         "annotations": {"pokoin.com/env-sha256": digest}},
            "data": dict(sorted(table.items()))}

print(digest)
print(json.dumps({"apiVersion": "v1", "kind": "List",
                  "items": [secret("pokoin-api-env", api), secret("pokoin-jobs-env", jobs)]}))
' "$WRITER_NET_IP" "$TCGCSV_NET_IP" "$HERMES_BRIDGE_IP:$HERMES_PORT" "$PG_ROLES_DIR")" || die "env secret not built ($ENV_SOURCE)"
  local digest="${manifest%%$'\n'*}"
  if [[ -n "${POKOIN_SECRET_DRY_RUN:-}" ]]; then
    say "env secrets from $ENV_SOURCE: ${digest:0:12} (applied: ${current:0:12}); dry run, nothing applied"
    return 0
  fi
  if [[ "$digest" == "$current" ]]; then
    say "env secrets unchanged ($ENV_SOURCE, ${digest:0:12})"
    return 0
  fi
  tail -n +2 <<<"$manifest" | kc apply -f - >/dev/null
  # The first hashed apply only records the hash: the pods' env is unknown, so no roll for it.
  [[ -z "$current" ]] || touch "$STATE/env.changed"
  say "env secrets applied from $ENV_SOURCE (${current:0:12} → ${digest:0:12}, $(kc -n "$NS" get secret pokoin-api-env -o jsonpath='{.data}' | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))') keys)"
}

# Key names (never values) that differ between the Pi process env and its env file.
env_diff() {
  python3 - <(ENV_SOURCE=pi-proc env_rows) <(ENV_SOURCE=pi-file env_rows) <<'PY'
import sys
def rows(path):
    with open(path, "rb") as fh:
        return dict(r.decode().partition("=")[::2] for r in fh.read().split(b"\0") if r)
a, b = rows(sys.argv[1]), rows(sys.argv[2])
print("only in the process:", sorted(set(a) - set(b)))
print("only in the file:   ", sorted(set(b) - set(a)))
print("different values:   ", sorted(k for k in set(a) & set(b) if a[k] != b[k]))
PY
}

# The Pi runs the aarch64 build of one commit; pods run the x86_64 build of the
# same commit, compiled here from a detached worktree of $REPO.
pi_commit() {
  ssh "$PI" /srv/pokoin/rust/current --version \
    | python3 -c 'import json, sys; d = json.load(sys.stdin); assert not d["dirty"], "dirty Pi build"; print(d["commit"])'
}

build_release() {
  local commit="$1" out="$2" src="$BASE/src" target="$BASE/build/target"
  if ! git -C "$src" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$REPO" worktree add -q --detach "$src" "$commit" 2>/dev/null \
      || { git -C "$REPO" fetch -q origin && git -C "$REPO" worktree add -q --detach "$src" "$commit"; }
  fi
  git -C "$src" cat-file -e "$commit^{commit}" 2>/dev/null || git -C "$src" fetch -q origin
  git -C "$src" checkout -q --detach --force "$commit"
  # The pods keep the current release when this refuses; a full / evicts them.
  bash "$(dirname "${BASH_SOURCE[0]}")/require-free-space.sh" "${POKOIN_K3S_MIN_FREE_GB:-30}" "$BASE"
  say "cargo build pokoin-api ${commit:0:12} (x86_64)"
  ( # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
    cd "$src/pokoin-rust"
    POKOIN_BUILD_COMMIT="$commit" POKOIN_BUILD_DIRTY=false CARGO_TARGET_DIR="$target" \
      nice -n 10 cargo build -q --release --locked -p pokoin-api )
  mkdir -p "$out"
  install -m 0755 "$target/release/pokoin-api" "$out/pokoin-api.new"
  "$out/pokoin-api.new" --version | grep -q "\"commit\":\"$commit\"" || die "built binary is not $commit"
  mv -f "$out/pokoin-api.new" "$out/pokoin-api"
}

sync_code() {
  local commit name current
  commit="$(pi_commit)" || die "cannot read the Pi Rust release"
  name="${commit:0:12}"
  current="$(readlink "$BASE/data/rust/current" 2>/dev/null || true)"
  if [[ "$current" == "releases/$name" && -x "$BASE/data/rust/releases/$name/pokoin-api" ]]; then
    say "rust release $name already current"
    return 1
  fi
  [[ -x "$BASE/data/rust/releases/$name/pokoin-api" ]] || build_release "$commit" "$BASE/data/rust/releases/$name"
  ln -sfn "releases/$name" "$BASE/data/rust/current.new"
  mv -Tf "$BASE/data/rust/current.new" "$BASE/data/rust/current"
  touch "$BASE/data/rust/releases/$name"
  # Keep the three newest releases, never the one just activated.
  ls -1t "$BASE/data/rust/releases" | grep -vxF "$name" | tail -n +3 | while read -r old; do
    rm -rf "${BASE:?}/data/rust/releases/$old"
  done
  say "rust release $name active"
  return 0
}

# Sitemaps the edge serves on api.pokoin.com (POKOIN_SEO_DIR on the Pi).
sync_seo() {
  mkdir -p "$BASE/data/seo"
  rsync -a --delete "$PI:/srv/pokoin/seo/" "$BASE/data/seo/"
}

# Silver-only extension zips GET /api/extension-download serves (Pi /srv/pokoin/extension).
sync_extension() {
  mkdir -p "$BASE/data/extension"
  rsync -rt --chmod=D750,F640 --delete "$PI:/srv/pokoin/extension/" "$BASE/data/extension/" || say "extension zips not synced"
}

sync_once() {
  network
  kc get ns "$NS" >/dev/null 2>&1 || kc create namespace "$NS" >/dev/null
  sync_secret
  sync_seo
  sync_extension
  local roll=""
  sync_code && roll="release"
  [[ -z "$roll" && -f "$STATE/env.changed" ]] && roll="env"
  if [[ -n "$roll" ]] && kc -n "$NS" get deploy pokoin-api >/dev/null 2>&1; then
    say "rolling pokoin-api ($roll changed)"
    kc -n "$NS" rollout restart deploy/pokoin-api >/dev/null
    kc -n "$NS" rollout status deploy/pokoin-api --timeout=180s
  fi
  rm -f "$STATE/env.changed"
  prune_pods
}

# A nezopt reboot leaves every running Deployment pod behind as Completed (graceful node
# shutdown) while its ReplicaSet starts a new one; nothing collects them. Job pods are
# kept by their CronJob history and are left alone.
prune_pods() {
  local n
  n="$(kc -n "$NS" delete pods --field-selector=status.phase==Succeeded \
    -l 'app in (cloudflared,cloudflared-cdn,pokoin-api,redis,meili)' --ignore-not-found -o name | wc -l)"
  [[ "$n" -eq 0 ]] || say "removed $n Completed Deployment pod(s) left by a node restart"
}

# Runs <fn> again while <stamp> is newer than the run's start: a hook that arrives while a
# run is in flight (systemctl start is then a no-op) is not lost.
#   follow <stamp name> <fn>
follow() {
  local stamp="$STATE/$1.stamp" mark="$STATE/$1.run" i
  mkdir -p "$STATE"
  for i in 1 2 3 4 5; do
    touch "$mark"
    "$2"
    [[ "$stamp" -nt "$mark" ]] || return 0
    say "$1: new Pi notice during the run, again ($i)"
  done
}

sync() { follow release sync_once; }

# Additive: a file deleted on the Pi stays here (never --delete), like the old poko-video-mirror unit.
video_once() {
  mkdir -p "$CDN_OBJECTS/poko-video"
  local changes
  changes="$(rsync -a --itemize-changes "$PI:$VIDEO_SRC" "$CDN_OBJECTS/poko-video/")"
  say "poko-video files copied: $(grep -c '^>f' <<<"$changes" || true)"
}

video() { follow video video_once; }

apply() {
  kc apply -f - <"$MANIFEST"
  # Retired Node CronJobs (now search-delta / search-reindex) and their scripts.
  kc -n "$NS" delete cronjob meili-delta meili-full --ignore-not-found
  kc -n "$NS" delete configmap redis-search-scripts --ignore-not-found
  # Security baseline (ServiceAccounts, PDBs, NetworkPolicies, cloudflared).
  kc apply -f - <"$(dirname "$MANIFEST")/pokoin-security.yaml"
}

reindex() {
  kc -n "$NS" delete job search-reindex-now --ignore-not-found >/dev/null
  kc -n "$NS" create job search-reindex-now --from=cronjob/search-reindex >/dev/null
  say "full Redis Search rebuild started (job search-reindex-now)"
  kc -n "$NS" wait --for=condition=complete job/search-reindex-now --timeout=1800s
  kc -n "$NS" logs job/search-reindex-now | tail -5
}

# A copy outside any git checkout, so the timer never runs someone's WIP.
install_timer() {
  local unit_dir="$HOME/.config/systemd/user"
  mkdir -p "$BASE/bin" "$unit_dir"
  install -m 0755 "$0" "$BASE/bin/nezopt-k3s.sh"
  mkdir -p "$BASE/bin/infra/k3s" && cp "$MANIFEST" "$(dirname "$MANIFEST")/pokoin-security.yaml" "$BASE/bin/infra/k3s/"
  cat >"$unit_dir/pokoin-overflow-sync.service" <<UNIT
[Unit]
Description=Pokoin overflow: follow the Pi Rust release and env into k3s on nezopt

[Service]
Type=oneshot
Environment=HOME=$HOME
ExecStart=$BASE/bin/nezopt-k3s.sh sync
# A release change compiles the Rust binary (minutes on a cold target dir).
TimeoutStartSec=2400
UNIT
  cat >"$unit_dir/pokoin-overflow-sync.timer" <<UNIT
[Unit]
Description=Pokoin overflow sync every 5 minutes

[Timer]
OnBootSec=3m
OnUnitActiveSec=5m
RandomizedDelaySec=30s

[Install]
WantedBy=timers.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now pokoin-overflow-sync.timer
  say "timer installed: $(systemctl --user list-timers pokoin-overflow-sync.timer --no-legend | head -1)"
}

status() {
  kc get nodes
  kc -n "$NS" get pods,hpa,svc,cronjob -o wide
  kc top pods -n "$NS" 2>/dev/null || true
  echo "rust release: $(readlink "$BASE/data/rust/current" 2>/dev/null || echo none), Pi: $(pi_commit 2>/dev/null | cut -c1-12)"
  # ClusterIP only (cloudflared is the way in): probe a pod from the k3s node.
  local ip
  ip="$(kc -n "$NS" get pods -l app=pokoin-api -o jsonpath='{.items[0].status.podIP}')"
  printf 'overflow readyz %s: ' "$ip"
  docker exec "$CONTAINER" wget -q -T 5 -O - "http://$ip:8080/readyz" || echo down
  echo
}

case "${1:-status}" in
  up) up ;;
  network) network ;;
  sync) sync ;;
  secret) network; sync_secret ;;
  _secret) apply_secret ;;
  video) video ;;
  env-diff) env_diff ;;
  apply) apply ;;
  reindex) reindex ;;
  status) status ;;
  install) install_timer ;;
  down) docker stop "$CONTAINER" ;;
  # Container flags (mounts, kubelet args) only apply at creation; cluster
  # state lives in $BASE/k3s and survives.
  recreate) docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; up ;;
  *) die "usage: $0 up|network|sync|secret|video|env-diff|apply|reindex|install|status|down|recreate" ;;
esac
