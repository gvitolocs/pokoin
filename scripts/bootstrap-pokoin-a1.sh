#!/usr/bin/env bash
# Run on pokoin-a1 (Ubuntu 24.04 aarch64) as ubuntu with sudo.
# Marketplace API + Postgres + Meili + Caddy. No chain peer.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if [[ "$(uname -m)" != "aarch64" ]]; then
  echo "bootstrap is for Ampere aarch64, got $(uname -m)" >&2
  exit 1
fi

sudo apt-get update -y
sudo apt-get install -y docker.io curl ca-certificates tar gzip

sudo usermod -aG docker ubuntu || true
sudo systemctl enable --now docker

# Caddy 2.11.4 arm64 (same as marketplace amd64)
if ! command -v caddy >/dev/null 2>&1; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/caddy.tgz" \
    "https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_linux_arm64.tar.gz"
  tar -C "$tmp" -xzf "$tmp/caddy.tgz" caddy
  sudo install -m 0755 "$tmp/caddy" /usr/bin/caddy
  rm -rf "$tmp"
fi
if [[ ! -f /etc/systemd/system/caddy.service ]]; then
  sudo tee /etc/systemd/system/caddy.service >/dev/null <<'UNIT'
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT
  sudo useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy 2>/dev/null || true
  sudo mkdir -p /etc/caddy /var/lib/caddy
  sudo chown -R caddy:caddy /var/lib/caddy
fi

# Meilisearch 1.10.3 aarch64
if [[ ! -x /usr/local/bin/meilisearch ]]; then
  curl -fsSL -o /tmp/meilisearch \
    "https://github.com/meilisearch/meilisearch/releases/download/v1.10.3/meilisearch-linux-aarch64"
  sudo install -m 0755 /tmp/meilisearch /usr/local/bin/meilisearch
  rm -f /tmp/meilisearch
fi
sudo useradd --system --home /opt/meilisearch --shell /usr/sbin/nologin meili 2>/dev/null || true
sudo mkdir -p /opt/meilisearch /var/lib/meilisearch /etc/pokemon-card-vault
sudo chown -R meili:meili /opt/meilisearch /var/lib/meilisearch

echo "bootstrap packages ready"
docker --version
caddy version
meilisearch --version
