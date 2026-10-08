#!/usr/bin/env bash
# Pokoin Pi overflow on nezopt: k3s running inside Docker (container pokoin-k3s),
# so nothing is installed on the host and `down` removes it cleanly.
#
#   scripts/nezopt-k3s.sh up             # start / create the k3s container
#   scripts/nezopt-k3s.sh sync           # Pi API release + env → nezopt, restart pods if changed
#   scripts/nezopt-k3s.sh apply          # kubectl apply infra/k3s/pokoin-overflow.yaml
#   scripts/nezopt-k3s.sh meili-full     # one-off full Meili build (first run / repair)
#   scripts/nezopt-k3s.sh status         # nodes, pods, HPA, overflow health
#   scripts/nezopt-k3s.sh install        # user timer: `sync` every 5 min (follows Pi API deploys)
#   scripts/nezopt-k3s.sh down           # stop the container (data kept in ~/pokoin-overflow)
#
# See docs/NEZOPT_OVERFLOW.md. The Pi edge (scripts/pokoin-api-edge.js) sends
# GET/HEAD API requests to http://192.168.178.55:30880 only when the Pi API is
# saturated and this cluster answers its health probe.
set -euo pipefail

K3S_IMAGE="${K3S_IMAGE:-rancher/k3s:v1.36.4-k3s1}"
CONTAINER="${K3S_CONTAINER:-pokoin-k3s}"
LAN_IP="${NEZOPT_LAN_IP:-192.168.178.55}"
NODE_PORT=30880
BASE="${POKOIN_OVERFLOW_HOME:-$HOME/pokoin-overflow}"
PI="${PI_HOST:-pi-home}"
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
  mkdir -p "$BASE/k3s" "$BASE/data/api/releases" "$BASE/data/meili"
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    docker start "$CONTAINER" >/dev/null
  else
    say "create $CONTAINER ($K3S_IMAGE)"
    docker run -d --name "$CONTAINER" --hostname nezopt-k3s --privileged --restart unless-stopped \
      --tmpfs /run --tmpfs /var/run \
      -v "$BASE/k3s:/var/lib/rancher/k3s" \
      -v "$BASE/data:/srv/pokoin-overflow" \
      "$K3S_IMAGE" server --disable traefik --disable servicelb \
      --write-kubeconfig-mode 600 --secrets-encryption --resolv-conf /var/lib/rancher/k3s/upstream-resolv.conf --node-name nezopt >/dev/null
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

# The Pi container's real environment (the .env file misses keys set at run time).
sync_secret() {
  ssh "$PI" "docker inspect pokoin-oracle-api" | python3 -c '
import base64, json, sys
env = json.load(sys.stdin)[0]["Config"]["Env"]
# NODE_TLS_REJECT_UNAUTHORIZED=0 would switch off certificate checks for every
# outbound TLS call in the pods; nothing needs it (every pg client sets its own ssl).
skip = {"PATH", "NODE_VERSION", "YARN_VERSION", "PORT", "HOSTNAME", "HOME", "NODE_TLS_REJECT_UNAUTHORIZED",
        # Pi-only: the Pi binds loopback and trusts its local edge; pods pin their own values.
        "ORACLE_API_HOST", "POKOIN_TRUSTED_PROXY_CIDRS"}
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
  say "secret pokoin-api-env synced from the Pi container ($(kc -n "$NS" get secret pokoin-api-env -o jsonpath='{.data}' | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))') keys)"
}

# Copy the Pi's live API release (code + node_modules; sharp ships x64 too).
sync_code() {
  local release name current
  release="$(ssh "$PI" 'readlink /srv/pokoin/api/current')" || die "cannot read Pi release"
  name="$(basename "$release")"
  current="$(readlink "$BASE/data/api/current" 2>/dev/null || true)"
  if [[ "$current" == "releases/$name" && -d "$BASE/data/api/releases/$name" ]]; then
    say "api release $name already current"
    return 1
  fi
  say "rsync Pi release $name"
  rsync -a --delete --exclude '.env' "$PI:/srv/pokoin/api/$release/" "$BASE/data/api/releases/$name/"
  ln -sfn "releases/$name" "$BASE/data/api/current.new"
  mv -Tf "$BASE/data/api/current.new" "$BASE/data/api/current"
  # Keep the three newest releases, never the one just activated: Pi releases
  # are cp -a copies, so their directory mtime is old and ls -t would sort the
  # new release last and delete it.
  touch "$BASE/data/api/releases/$name"
  ls -1t "$BASE/data/api/releases" | grep -vxF "$name" | tail -n +3 | while read -r old; do
    rm -rf "$BASE/data/api/releases/$old"
  done
  return 0
}

sync() {
  network
  kc get ns "$NS" >/dev/null 2>&1 || kc create namespace "$NS" >/dev/null
  sync_secret
  if sync_code; then
    if kc -n "$NS" get deploy pokoin-api >/dev/null 2>&1; then
      kc -n "$NS" rollout restart deploy/pokoin-api >/dev/null
      kc -n "$NS" rollout status deploy/pokoin-api --timeout=180s
    fi
  fi
}

apply() {
  kc apply -f - <"$MANIFEST"
  # Security baseline (ServiceAccounts, PDBs, NetworkPolicies, cloudflared).
  kc apply -f - <"$(dirname "$MANIFEST")/pokoin-security.yaml"
}

meili_full() {
  kc -n "$NS" delete job meili-full-now --ignore-not-found >/dev/null
  kc -n "$NS" create job meili-full-now --from=cronjob/meili-full >/dev/null
  say "full Meili build started (job meili-full-now)"
  kc -n "$NS" wait --for=condition=complete job/meili-full-now --timeout=1800s
  kc -n "$NS" logs job/meili-full-now | tail -5
}

# A copy outside any git checkout, so the timer never runs someone's WIP.
install_timer() {
  local unit_dir="$HOME/.config/systemd/user"
  mkdir -p "$BASE/bin" "$unit_dir"
  install -m 0755 "$0" "$BASE/bin/nezopt-k3s.sh"
  mkdir -p "$BASE/bin/infra/k3s" && cp "$MANIFEST" "$BASE/bin/infra/k3s/"
  cat >"$unit_dir/pokoin-overflow-sync.service" <<UNIT
[Unit]
Description=Pokoin overflow: follow the Pi API release and env into k3s on nezopt

[Service]
Type=oneshot
Environment=HOME=$HOME
ExecStart=$BASE/bin/nezopt-k3s.sh sync
TimeoutStartSec=600
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
  kc -n "$NS" get pods,hpa,svc -o wide
  kc top pods -n "$NS" 2>/dev/null || true
  printf 'overflow health %s: ' "http://$LAN_IP:$NODE_PORT/healthz"
  curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' --max-time 5 "http://$LAN_IP:$NODE_PORT/healthz" || echo down
}

case "${1:-status}" in
  up) up ;;
  network) network ;;
  sync) sync ;;
  apply) apply ;;
  meili-full) meili_full ;;
  status) status ;;
  install) install_timer ;;
  down) docker stop "$CONTAINER" ;;
  *) die "usage: $0 up|network|sync|apply|meili-full|install|status|down" ;;
esac
