# Bootstrap peer JSON — public vs operator

Checked 30 Aug 2026 against live `https://rpc.pokoin.com/network/bootstrap-peers.json`, `https://pokoin.com/bootstrap-peers.json`, Ethereum / Bitcoin / Cosmos seed formats, and [OWASP API3:2023](https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/) (excessive data exposure).

**Short answer:** a public bootstrap file may list **dialable host:port**. It must not dump the operator model. Ours did. That is not normal.

---

## Is a fat public list “normal”?

| What public chains publish | Typical shape | Operator names, health URLs, vetting math |
| --- | --- | --- |
| Bitcoin DNS seeds | A/AAAA records only (IPs). Default port implied. | No |
| Ethereum bootnodes | `enode://<node-id>@ip:port` (or ENR / discv5). IPs are required so a new node can dial. | No. Geth `admin.peers` is local, not a public URL. |
| Cosmos / CometBFT | `id@host:port` in `config.toml` / seeds | No |
| **Pokoin before this change** | Full probe document every 15s | Yes — labels, internal ids, `opsHealthUrl`, grandfathered flags, uptime ratios, policy, duplicate `candidates`, `offline[]` |

Publishing **join addresses** is how P2P networks work. Serializing the **internal registry** onto the same URL is [OWASP API3](https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/): cherry-pick the properties the caller needs; do not `to_json()` the operator object.

Pokoin is also **permissioned** (no open intake). That makes host:port *more* sensitive than on Ethereum, not less. The landing already hides names and IPs. The JSON the page linked was still the full dump.

Related guidance:

- [ethereum.org bootnodes](https://ethereum.org/en/developers/docs/nodes-and-clients/bootnodes/) — bootnodes are dialable endpoints, not ops dashboards.
- [Bitcoin P2P / DNS seeds](https://developer.bitcoin.org/devguide/p2p_network.html) — IPs only; seeds are unauthenticated (eclipse risk); do not treat a seed as a trust oracle.
- [OWASP SCS node infrastructure](https://scs.owasp.org/handbooks/07-infrastructure-security/part2-node-and-compute-infrastructure/) — public RPC allowlists; admin/debug stay private.
- [CWE-213](https://cwe.mitre.org/data/definitions/213.html) — exposure of sensitive information due to incompatible policies (same object, public vs operator view).

---

## What was exposed (before)

Live writer: `pokoinpos-network-status.timer` on `pokoin-peer1` → `/opt/pokoinpos-docker/network-status.py` → `/var/www/pokoinpos-network/` (Caddy `handle /network/*`). Refresh **15s**. `nodes.json` was a byte-for-byte copy of the fat file.

Fields on each peer that a landing page or anonymous GET did not need:

| Field | Why it was extra |
| --- | --- |
| `id` (`oracle-peer1`) | Internal inventory name |
| `label` (`pokoin-peer1`, `pokoin-marketplace`) | Operator hostname / VM role |
| `host` + `port` (also in `fallbackPeers` and `bootstrap.defaultJoinPeer`) | Required for **node join**, not for the marketing page |
| `opsHealthUrl` | Maps a peer to a public ops path (`/health`, `/nodes/peer2/health`) |
| `grandfathered`, `ageDays`, `externalObservers`, `vettingUptimeRatio`, `uptimeRatio365d` | Registry / policy internals |
| `policy.*`, `probeIntervalSeconds` | How often we probe and the intake rules |
| `candidates` duplicate of `peers` | Same object twice |
| `offline[]` | Full records of down nodes |

`https://pokoin.com/bootstrap-peers.json` (node default `POKOINPOS_BOOTSTRAP_MANIFEST_URL`) was **worse**: it still listed deleted Always Free VMs as join targets and used old labels (`pokoin-vm2` / `vm3` / `vm4`).

Same stale document was re-exported by the node at **`GET /chain/bootstrap`** on both `rpc.pokoin.com` and `explorer.pokoin.com` (Caddy reverse-proxy to ops `:8080`).

---

## Split (after)

Three audiences, three documents.

```
Anonymous visitor / landing
  GET https://rpc.pokoin.com/network/peer-status.json
  city, country, countryCode, reachable, chainHeight, livePeerCount
  no host, port, id, label, ops URL, policy

Node joining the permissioned set
  GET https://rpc.pokoin.com/network/bootstrap-peers.json
  (and https://pokoin.com/bootstrap-peers.json for the static copy)
  host, port, reachable, height, version, fallbackPeers
  schemaVersion 2 — no candidates, policy, labels, opsHealthUrl

Operator on the VM
  /var/lib/pokoinpos/network-status-full.json
  not in the Caddy www root
```

Source of the live files: `pokoinpos/deploy/scripts/network-status.py` (installed on peer1 as `/opt/pokoinpos-docker/network-status.py`).

Go nodes only read `peers[].host` / `port` (and fallbacks) from the join manifest (`peer/bootstrap_manifest.go`). Extra operator fields were never required for dial.

---

## Landing

- Snapshot rows: flag + place only.
- Idle refresh: `peer-status.json` + `/health` (height / status).
- Do **not** fetch or link `bootstrap-peers.json` from `pokoin.com/`.
- `landing.js` must not contain operator labels as display strings.

---

## Still public (not changed in this pass)

These are adjacent, not the landing JSON:

| URL | Issue |
| --- | --- |
| `GET https://rpc.pokoin.com/health` | Needed for height; also returns lottery counters, `validatorStake`, mempool depth |
| `GET https://rpc.pokoin.com/nodes/peer2/health` | Caddy proxies the second node’s ops health |
| `GET /chain/bootstrap` on rpc + explorer | Re-publishes whatever the node last fetched from `pokoin.com/bootstrap-peers.json` |

Follow-ups (do not do without an explicit pass): allowlist `/health` fields; stop proxying `/nodes/peer2/*` to the internet; bind `/chain/bootstrap` to loopback or require admin token (dashboard already expects local `/chain/bootstrap`).

DNS names (`peer1.pokoin.com`) instead of raw IPs in the join list would reduce “copy this OCI address” without hiding P2P (the IP still resolves). That is a later change.

---

## Verify

```bash
# Public proof: geo only
curl -sS https://rpc.pokoin.com/network/peer-status.json
# must not contain operator labels or dotted-quad join targets

# Join list: host:port only, live nodes only
curl -sS https://rpc.pokoin.com/network/bootstrap-peers.json
# must not contain opsHealthUrl, grandfathered, policy, candidates, pokoin-peer1

# Landing must not advertise the join list
curl -sS https://pokoin.com/ | grep -E 'peer-status|bootstrap-peers'
```
