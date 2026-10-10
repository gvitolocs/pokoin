#!/usr/bin/env bash
# Pokoin Pi overflow on nezopt: k3s running inside Docker (container pokoin-k3s),
# so nothing is installed on the host and `down` removes it cleanly.
#
#   scripts/nezopt-k3s.sh up             # start / create the k3s container
#   scripts/nezopt-k3s.sh sync           # Pi Rust release (x86 build) + env + sitemaps → nezopt, restart pods if changed
#   scripts/nezopt-k3s.sh apply          # kubectl apply infra/k3s/pokoin-overflow.yaml
#   scripts/nezopt-k3s.sh secret         # only rebuild the env secret from the Pi Rust service
#   scripts/nezopt-k3s.sh reindex        # one-off full Redis Search rebuild (first run / repair)
#   scripts/nezopt-k3s.sh status         # nodes, pods, HPA, overflow health
#   scripts/nezopt-k3s.sh install        # user timer: `sync` every 5 min (follows Pi API deploys)
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
REPO="${POKOIN_REPO:-$HOME/Projects/pokoin-web}"
NS=pokoin-overflow
# UFW drops container → host traffic, so pods reach the writer Postgres
# container directly on a user-defined Docker network with fixed addresses.
NET=pokoin-overflow
NET_SUBNET=172.31.250.0/24
WRITER_CONTAINER="${WRITER_CONTAINER:-pokoin-marketplace-postgres-15t}"
WRITER_NET_IP=172.31.250.10
TCGCSV_CONTAINER="${TCGCSV_CONTAINER:-tcgprices-postgres-15t}"
TCGCSV_NET_IP=172.31.250.11
K3S_NET_IP=172.31.250.20
HERE="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$HERE/infra/k3s/pokoin-overflow.yaml"
[[ -f "$MANIFEST" ]] || MANIFEST="$(cd "$HERE/.." && pwd)/infra/k3s/pokoin-overflow.yaml"

say() { echo "== $*"; }
die() { echo "nezopt-k3s: $*" >&2; exit 1; }
kc() { docker exec -i "$CONTAINER" kubectl "$@"; }

up() {
  mkdir -p "$BASE/k3s" "$BASE/data/rust/releases" "$BASE/data/seo" "$BASE/data/meili"
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

network() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet "$NET_SUBNET" "$NET" >/dev/null
  local attached
  attached="$(docker network inspect "$NET" --format '{{range .Containers}}{{.Name}} {{end}}')"
  [[ " $attached " == *" $WRITER_CONTAINER "* ]] || docker network connect --ip "$WRITER_NET_IP" "$NET" "$WRITER_CONTAINER"
  [[ " $attached " == *" $CONTAINER "* ]] || docker network connect --ip "$K3S_NET_IP" "$NET" "$CONTAINER"
  if docker inspect "$TCGCSV_CONTAINER" >/dev/null 2>&1; then
    [[ " $attached " == *" $TCGCSV_CONTAINER "* ]] || docker network connect --ip "$TCGCSV_NET_IP" "$NET" "$TCGCSV_CONTAINER"
  fi
}

# The running Pi Rust service's real environment (/proc/<pid>/environ: the
# EnvironmentFile after systemd unquoting, plus the unit's own Environment=).
sync_secret() {
  ssh "$PI" "pid=\$(systemctl show -p MainPID --value $PI_UNIT); [ \"\$pid\" -gt 0 ] && cat /proc/\$pid/environ" \
    | python3 -c '
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
print(json.dumps({"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
                  "metadata": {"name": "pokoin-api-env", "namespace": "pokoin-overflow"},
                  "data": data}))
' "$WRITER_NET_IP" "$TCGCSV_NET_IP" | kc apply -f - >/dev/null
  say "secret pokoin-api-env synced from the Pi Rust service ($(kc -n "$NS" get secret pokoin-api-env -o jsonpath='{.data}' | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))') keys)"
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

sync() {
  network
  kc get ns "$NS" >/dev/null 2>&1 || kc create namespace "$NS" >/dev/null
  sync_secret
  sync_seo
  if sync_code; then
    if kc -n "$NS" get deploy pokoin-api >/dev/null 2>&1; then
      kc -n "$NS" rollout restart deploy/pokoin-api >/dev/null
      kc -n "$NS" rollout status deploy/pokoin-api --timeout=180s
    fi
  fi
}

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
  mkdir -p "$BASE/bin/infra/k3s" && cp "$MANIFEST" "$BASE/bin/infra/k3s/"
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
  apply) apply ;;
  reindex) reindex ;;
  status) status ;;
  install) install_timer ;;
  down) docker stop "$CONTAINER" ;;
  # Container flags (mounts, kubelet args) only apply at creation; cluster
  # state lives in $BASE/k3s and survives.
  recreate) docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; up ;;
  *) die "usage: $0 up|network|sync|secret|apply|reindex|install|status|down|recreate" ;;
esac
