# API security hardening (2026-10-07)

Live system: Cloudflare Load Balancer `api.pokoin.com` (pool `pokoin-api`, origins
`pi` 0.9 / `nez` 0.1, monitor `GET /readyz`). Pi tunnel → edge `127.0.0.1:18079`
→ Node `127.0.0.1:18080`. NEZ tunnel → cloudflared pods → ClusterIP Service
`pokoin-api:8080` → API pods. Postgres: NEZ primary `:25433`, Pi streaming
replica `127.0.0.1:5432`. Topology and weights were not changed.

## Transport

| Path | Before | Now |
| --- | --- | --- |
| Outbound HTTPS (Stripe, Google/Firebase, R2, CDN, CardTrader, Supabase, …) | `NODE_TLS_REJECT_UNAUTHORIZED=0` on Pi and NEZ | flag removed everywhere; every endpoint verifies normally |
| Pi API → NEZ writer | `sslmode=disable` | `sslmode=verify-full`, Pokoin PG CA |
| k3s pods → NEZ primary | `sslmode=disable` | `sslmode=verify-full` (`secret/pokoin-pg-ca` mounted at `/etc/pokoin/pg-ca`) |
| Pi replica ← NEZ primary (WAL) | `sslmode=prefer` (TLS was off on the primary) | `sslmode=verify-full`, TLS 1.3 |
| Pi API → Pi replica | TLS, self-signed, unverified | TLS, CA-signed cert (loopback only) |

Why the flag existed: the oldest pg clients used `sslmode=require` against a
self-signed Postgres; node-postgres treated that as full verification, and the
global flag silenced it. Every pool now sets its own `ssl` (and `uselibpqcompat`),
so nothing needed it. The private CA lives on nezopt `~/secrets/pokoin-pg-ca`
(key never leaves nezopt); server certs: NEZ (SAN 192.168.178.55, 172.31.250.10,
127.0.0.1), Pi (SAN 127.0.0.1, 192.168.178.46).

## Postgres access (pg_hba, first match wins)

Audited from `log_connections` (7 h, both servers). Broad `host all all all` removed.

| Source | Role | DB | Rule |
| --- | --- | --- | --- |
| Pi 192.168.178.46 (API writer) | pokoin_marketplace | all | `hostssl` scram |
| Pi 192.168.178.46 (replica) | pokoin_replicator | replication | `hostssl` scram |
| k3s 172.31.250.20 (pods, SNAT) | pokoin_marketplace | all | `hostssl` scram |
| nezopt-local jobs, Oracle dump reverse tunnel (172.17.0.1 / 192.168.178.55) | pokoin_marketplace | all | `host` scram (never leaves the host) |
| container-internal (docker exec) | any | any | local trust |
| anything else (other LAN hosts, plaintext from Pi/k3s, other roles) | — | — | rejected |

Pi replica: only `hostssl all pokoin_marketplace 172.18.0.1/32` (the local API via
the loopback-published port) plus container-local. It now listens on `127.0.0.1:5432`.

Open: every client still logs in as the superuser `pokoin_marketplace`. A
least-privilege role needs a per-route migration (some handlers run
`create table if not exists` at runtime).

## Ingress

| Entry | Before | Now |
| --- | --- | --- |
| NEZ NodePort `:30880` (old overflow) | LAN-reachable | Service is ClusterIP; k3s no longer publishes the port |
| Pi Node `:18080` | `0.0.0.0` | `127.0.0.1` (`ORACLE_API_HOST`) |
| Pi Postgres `:5432` | `0.0.0.0` | `127.0.0.1` |
| Pi LAN surface | 22, 5432, 18080 | 22 only |

The Pi API container is created from `/srv/pokoin/api/container.env` (root, 0600) with
`-v /etc/pokoin/pg-ca:/etc/pokoin/pg-ca:ro`; deploy scripts keep using `docker restart`.

## Kubernetes (namespace pokoin-overflow)

- NetworkPolicy is enforced by k3s's embedded kube-router controller (verified with a
  deny-all test namespace). `infra/k3s/pokoin-security.yaml`: default deny, DNS for all,
  API ingress only from cloudflared, API egress only to Redis, Meili, the primary and
  TCGCSV on the Docker network, the scan bridge and public 443; cloudflared egress only
  to the API and Cloudflare (7844/443); Redis/Meili ingress only from the API and index jobs.
- API and cloudflared: dedicated ServiceAccounts, no token, `runAsNonRoot`, no privilege
  escalation, all capabilities dropped, `RuntimeDefault` seccomp, read-only root (API `/tmp`
  is an emptyDir). cloudflared gained `/ready` probes.
- PDB `minAvailable: 1` for the API and cloudflared.
- Secrets encryption at rest: k3s started with `--secrets-encryption`, `rotate-keys` →
  `reencrypt_finished` (aescbc). k3s also uses `--resolv-conf` with a real upstream (Docker's
  embedded 127.0.0.11 made CoreDNS detect a loop).
- `nezopt-k3s.sh sync` writes verify-full DSNs and never copies `NODE_TLS_REJECT_UNAUTHORIZED`,
  `ORACLE_API_HOST` or `POKOIN_TRUSTED_PROXY_CIDRS` from the Pi; `apply` applies both manifests.

## Application

- One client-IP implementation (`server/pokoin-api/_client_ip.js`): proxy headers are honoured
  only from trusted peers (`POKOIN_TRUSTED_PROXY_CIDRS`: Pi loopback; NEZ pod CIDR, reachable only
  by cloudflared because of NetworkPolicy). The server entry rewrites the headers so every legacy
  handler sees the trusted value.
- One CORS allowlist (`server/pokoin-api/_cors_policy.js`) used by the Pi edge and the Node server on
  every status code; credentials only for exact Pokoin origins; never `*` with credentials.
- Invalid Firebase tokens → 401 `Invalid or expired sign-in token.`; verifier outages → 503.
- `/api/__routes` is off unless `POKOIN_EXPOSE_ROUTE_MANIFEST=1`.
- Rate limits: security/cost limiters are global in Postgres (`marketplace_rate_limits`), degrade to
  the origin Redis at half the limit when the primary is unreachable, fail closed if Redis is down too.
- Responses whose game came from a header (not `?game=`) are `private, no-store`, so Cloudflare cannot be
  poisoned across games.
