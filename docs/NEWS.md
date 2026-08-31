# Pokoin News (`news.pokoin.com`) — Oracle + Cloudflare Tunnel

Hypemeter (Next.js) is the Pokoin News app. Target live host:
`https://news.pokoin.com`, on Oracle behind a Cloudflare named tunnel.

**Today:** DNS for `news.pokoin.com` is still Vercel Hobby (`hypemeter` /
`monmeter.vercel.app`). Always Free Ampere `pokoin-a1` is not RUNNING yet
(Frankfurt capacity). Leave Vercel up until cutover is verified. Do not
delete that project until you say so.

## Pipeline

```
hypemeter/                 pokoin-a1 (Ampere 2 OCPU / 12 GB)
Dockerfile + compose  ──►  127.0.0.1:3000  (sqlite volume)
                            cloudflared named tunnel pokoin-news
                                    │
visitors ──► Cloudflare news.pokoin.com (CNAME → <tunnel>.cfargotunnel.com)
```

The Oracle public IP is **not** in DNS. The VM makes an outbound tunnel only.
Do not put an A record for `news.pokoin.com` on `130.61.251.250` or the A1 IP.

A VPN would hide the origin and also hide the site from the public internet.
The tunnel is the hide-IP path that still publishes a public site.

## Why not the two existing micros

Both Always Free AMD micros are already full (~1 GB RAM, already swapping):

- `pokoin-marketplace` — Postgres + `pokoin-oracle-api`
- `pokoin-peer1` — PokoinPoS seed

Do not put Next + native sqlite there. Do not delete those boot volumes.

Always Free Ampere is **2 OCPU / 12 GB** (not 4/24). Host is `pokoin-a1`.

**Do not** run `scripts/oci-a1-2x12-hunt.sh` for this host: that script
auto-migrates marketplace when the VM comes up. News hunt is
`scripts/oci-a1-2x12-hunt-news.sh` (launch only). Marketplace stays on the
micro until you separately approve a migrate.

## Hunt → compose → tunnel → cron → cutover

### 1. Hunt / launch A1

```bash
nohup /home/nez/Projects/pokoin-web/scripts/oci-a1-2x12-hunt-news.sh \
  >> /tmp/pokoin-a1-news-hunt.log 2>&1 &
```

Frankfurt often returns HTTP 400 `LimitExceeded` for `standard-a1-*-regional-count`
even when tenancy quota still shows **2 OCPU / 12 GB available**. That is empty
physical capacity, not a paid-limit problem. The hunt also tries **1 OCPU / 6 GB**
then resizes to 2/12 if a smaller Flex VM lands. Never 4/24.

Log: `/tmp/pokoin-a1-news-hunt.log`. Instance OCID: `/tmp/pokoin-a1.instance.id`.

### 2. Compose on localhost

On `pokoin-a1` (aarch64), Docker Compose builds Hypemeter (Node 22,
`better-sqlite3` for arm64) and binds **`127.0.0.1:3000` only**. Sqlite lives
in the `hypemeter-data` volume (`HYPEMETER_SQLITE_DIR=/data`).

Source image files: `/home/nez/Projects/hypemeter/Dockerfile` and
`docker-compose.yml`. Install from this repo:

```bash
bash /home/nez/Projects/pokoin-web/scripts/install-hypemeter-a1.sh
```

Or wait for the hunt:

```bash
bash /home/nez/Projects/pokoin-web/scripts/wait-and-install-hypemeter-a1.sh
```

NSG `pokoin-a1-hypemeter` does not open 80/443. The **shared subnet security
list** still allows 80/443 (marketplace API on the same VCN). Hypemeter must
not listen on those ports. Confirm with `ss -lnt` that `:3000` is
`127.0.0.1` only.

SSH host alias: `pokoin-a1` (ubuntu, `~/.ssh/id_ed25519` — the hunt injects
that pubkey).

### 3. Named tunnel

Tunnel name: `pokoin-news` (already created; token in
`~/secrets/deploy/hypemeter/`, not git). DNS still points at Vercel until
step 5. Ingress:

- `news.pokoin.com` → `http://127.0.0.1:3000`
- catch-all `http_status:404`

Create/reuse (writes token under `~/secrets/deploy/hypemeter/`, not git):

```bash
bash /home/nez/Projects/pokoin-web/scripts/create-pokoin-news-tunnel.sh
```

`cloudflared` systemd unit: `cloudflared-news.service` (token file, not a
command-line secret).

### 4. Revalidate timer

Vercel Hobby was one cron per day. On A1 a systemd timer every 15 minutes:

`GET http://127.0.0.1:3000/api/cron/revalidate-home` with
`Authorization: Bearer $CRON_SECRET`.

Units: `scripts/hypemeter-a1/hypemeter-revalidate.{service,timer}`.
Secret: `~/secrets/deploy/hypemeter/cron.env` (not git).

### 5. DNS cutover

`install-hypemeter-a1.sh` (default `HYPEMETER_CUTOVER_DNS=1`) patches the
existing `news.pokoin.com` CNAME to `<tunnel-id>.cfargotunnel.com`, **proxied**.
Never an A record to a VM IP.

Verify the origin is A1, not Vercel:

```bash
curl -sSI https://news.pokoin.com/ | grep -iE '^(HTTP/|x-vercel|cf-ray|server:)'
curl -sSI https://news.pokoin.com/ | grep -i x-vercel-id && echo STILL_VERCEL || echo no_vercel_id
```

HTML should be Next from A1. There must be **no** `x-vercel-id`.

Rollback alias until you approve teardown: `https://monmeter.vercel.app`
(Vercel project `hypemeter`). Do **not** delete that project until you say so.

## Out of scope

- Ad / affiliate code (hosting only so you *can* monetize).
- Moving marketplace Postgres onto A1 in the same pass.
- Changing `app.pokoin.com` (Flutter).
