#!/usr/bin/env bash
# Create or reuse the named Cloudflare tunnel pokoin-news. Writes id+token under
# ~/secrets/deploy/hypemeter (not git). Does not change news.pokoin.com DNS.
set -euo pipefail
python3 - <<'PY'
import json, os, pathlib, urllib.error, urllib.request

acct = os.environ["CLOUDFLARE_ACCOUNT_ID"]
secret_dir = pathlib.Path("/home/nez/secrets/deploy/hypemeter")
secret_dir.mkdir(parents=True, exist_ok=True)
os.chmod(secret_dir, 0o700)

def auth_headers():
    # Account API token can list tunnels but often cannot create them.
    # Global key can create Zero Trust tunnels.
    if os.environ.get("CLOUDFLARE_EMAIL") and os.environ.get("CLOUDFLARE_API_KEY"):
        return {
            "X-Auth-Email": os.environ["CLOUDFLARE_EMAIL"],
            "X-Auth-Key": os.environ["CLOUDFLARE_API_KEY"],
            "Content-Type": "application/json",
        }
    return {
        "Authorization": f"Bearer {os.environ['CLOUDFLARE_API_TOKEN']}",
        "Content-Type": "application/json",
    }

def cf(method, url, data=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers=auth_headers(),
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", "replace")
        raise SystemExit(f"{method} {url} HTTP {e.code}: {err[:800]}") from e

listed = cf("GET", f"https://api.cloudflare.com/client/v4/accounts/{acct}/cfd_tunnel?is_deleted=false")
existing = [t for t in (listed.get("result") or []) if t.get("name") == "pokoin-news"]
if existing:
    tid = existing[0]["id"]
    print("reuse_tunnel", tid)
else:
    created = cf(
        "POST",
        f"https://api.cloudflare.com/client/v4/accounts/{acct}/cfd_tunnel",
        {"name": "pokoin-news", "config_src": "cloudflare"},
    )
    if not created.get("success"):
        raise SystemExit("create_failed " + json.dumps(created.get("errors"))[:400])
    tid = created["result"]["id"]
    print("created_tunnel", tid)

cfg = cf(
    "PUT",
    f"https://api.cloudflare.com/client/v4/accounts/{acct}/cfd_tunnel/{tid}/configurations",
    {
        "config": {
            "ingress": [
                {"hostname": "news.pokoin.com", "service": "http://127.0.0.1:3000"},
                {"service": "http_status:404"},
            ]
        }
    },
)
print("config_success", cfg.get("success"), "errors", cfg.get("errors"))

tok = cf("GET", f"https://api.cloudflare.com/client/v4/accounts/{acct}/cfd_tunnel/{tid}/token")
raw = tok.get("result")
if isinstance(raw, dict):
    tval = raw.get("token") or raw.get("tunnel_token") or ""
else:
    tval = raw or ""
if not tval:
    raise SystemExit("empty_token")

(secret_dir / "tunnel.id").write_text(tid + "\n")
token_path = secret_dir / "tunnel.token"
token_path.write_text(str(tval).strip() + "\n")
os.chmod(token_path, 0o600)
print("wrote", secret_dir / "tunnel.id", "token_chars", len(str(tval).strip()))
print("cname_target", f"{tid}.cfargotunnel.com")
PY
