# Serving pipeline: one description, pure render, checked invariants

Status: **plan, not implemented** (2026-10-29). Trigger: incident `d6c7d1df823051b6`
(every `cdn.pokoin.com` image 502 for an hour, the second time in two days).

## Why

Today the serving system is the sum of hand steps:

- Cloudflare tunnel ingress and the API load balancer live only in the dashboard.
- Host facts (the Pi's `127.0.0.1 pokoin-cdn-origin`, tunnel tokens, drop-ins) are typed in by hand.
  They are mentioned in commit messages at best.
- About 60 `scripts/install-*` / `deploy-*` scripts each mutate one host, and nothing says what the
  whole system should look like.

So a reboot, a rebuild or a second session can quietly break a rule that one commit message
remembered, and nothing checks it. The CDN outage was exactly that:

1. The shared `pokoin-cdn` tunnel has one ingress rule, `http://pokoin-cdn-origin:18081`.
2. That name resolves in k3s through a Service. On the Pi it resolved only through a hand-edited
   `/etc/hosts`.
3. cloud-init (`manage_etc_hosts: True`) rewrote `/etc/hosts` on boot.
4. Cloudflare kept routing to the Pi connector, which was still "connected", so every request got a 502.

The answer is not more patches per host. It is a pipeline in which the system is **data**, every
host's files are a **pure function** of that data, and the rules that were broken are
**invariants a checker proves** before anything is applied and **probes verify** after.

## The pipeline

```
topology (data) ─► check ─► render ─► plan ─► apply ─► verify ─► record
     │              │         │         │        │        │         │
  infra/       static +    pure fn   diff vs  idempotent live     Lucina
  topology/    TLC model   per host  live     per host   probes   ops_record
```

| Stage | What | Pure? | Fails the pipeline when |
| --- | --- | --- | --- |
| **topology** | `infra/topology/*.toml`: hosts, services, tunnels + ingress, LB pools + monitors, name bindings, sync edges, probes | data | it doesn't parse or validate |
| **check** | `pokoin-infra check` (static invariants below) + `specs/tla/serving/` (TLC) | yes | any invariant is violated |
| **render** | `pokoin-infra render <host>` → files: hosts *and* the cloud-init template, systemd units/drop-ins, cloudflared ingress JSON, k3s manifest fragments | yes (no IO) | the golden tests differ |
| **plan** | `pokoin-infra plan <host>`: reads the live files/API read-only and prints a diff | read-only | drift on a file it owns |
| **apply** | `pokoin-infra apply <host>`: writes only the rendered files, behind the deploy guard, with backups | idempotent | apply twice ≠ no-op |
| **verify** | `pokoin-infra verify`: resolve every name on every host, fetch through each origin and the public URL, compare live and rendered | read-only | a probe fails |
| **record** | `ops_record` deploy entry with the topology hash | — | — |

`verify` also runs every 5 minutes as checks inside `pokoin-ops sentinel` (Pi and nezopt roles),
so a broken invariant pages within minutes instead of when the owner notices.

Tooling follows the repo's conventions: a Rust crate `pokoin-rust/crates/infra` (pure core +
thin IO shell), TLA+ under `specs/tla/serving/` in the existing layout (`*.cfg` must pass;
`bugs/` reproduce incidents; `witness/` prove non-vacuity), run with `specs/tla/run.sh` through
`verify-gate` on nezopt.

## The system as data (first cut)

Hosts: `pi-home`, `nezopt` (host), `nezopt-k3s` (k3s-in-Docker `pokoin-k3s`, namespace
`pokoin-overflow`), `oracle-marketplace`. Public names: `pokoin.com` (Cloudflare static +
Workers), `api.pokoin.com` (LB, Pi 0.9 / NEZ 0.1), `cdn.pokoin.com` (shared tunnel, connectors on
Pi and k3s).

```toml
[tunnel.pokoin-cdn]
hostname = "cdn.pokoin.com"
origin   = { name = "pokoin-cdn-origin", port = 18081 }
connectors = ["pi-home:cloudflared-cdn", "nezopt-k3s:cloudflared-cdn"]

[binding."pi-home".pokoin-cdn-origin]
via = "hosts"            # rendered into /etc/hosts AND /etc/cloud/templates/hosts.debian.tmpl
address = "127.0.0.1"

[binding."nezopt-k3s".pokoin-cdn-origin]
via = "k8s-service"      # Service pokoin-cdn-origin in infra/k3s/pokoin-overflow.yaml
```

Sync edges (one writer per key space): Pi `card-images/objects` → nezopt leftover mirror (read-only);
Pi `poko-video/` → k3s CDN root; Pi release + env → k3s secrets (`nezopt-k3s.sh sync`); nezopt
writer Postgres → Pi replica. Fallbacks: k3s CDN miss → Pi CDN via `pokoin-pi-cdn-tunnel`.

## Invariants

Static (checked on the data by `pokoin-infra check`; each one has a negative test):

- **S1 Names resolve everywhere they are used.** Every origin name in a tunnel's ingress has a binding
  on every host that runs a connector of that tunnel.
- **S2 Bindings survive reboot.** A binding is `k8s-service`, or `hosts` rendered into both the live
  file and the boot template that regenerates it. A hand-edited live file is never a binding.
- **S3 Nothing load-bearing is hand-managed.** Every file the pipeline relies on is either rendered
  or listed with a reason in `infra/topology/exceptions.toml`.
- **S4 Every public hostname is probed end to end.** Each one has at least one probe that fetches a
  real object through the public URL, from outside the serving hosts.
- **S5 Fallback graph is acyclic.** The loop guard in `edge/src/cdn.rs` (one hop) is backed by the data.
- **S6 One writer per key space.** Mirrors are read-only, and no two sync edges write the same path.

Dynamic (TLA+ `specs/tla/serving/Model.tla`, TLC):

- **D1 Reboot safety.** For any interleaving of `Reboot(h)`, `Apply(h)`, `ManualEdit(h)` and
  `CloudInitRegen(h)`, once `Apply` has run, `Resolves(h, name)` holds in every later state.
  `bugs/hand-hosts.cfg` reproduces today's incident (live-only edit + regen).
- **D2 No false failover.** A connector only receives traffic while its origin answers. Cloudflare
  routes to any *connected* connector, so the model makes the connector depend on origin health:
  `cloudflared-cdn` starts after an `ExecCondition` on origin resolution and health, and is stopped
  when the origin dies. The property: `Connected(c) ⇒ OriginHealthy(c)` (up to one probe period).
  `bugs/connected-not-healthy.cfg` reproduces the 502s.
- **D3 Availability.** `WF` over probe and restart: if some origin is healthy and the pipeline has
  converged, a public request eventually returns 200 (`◇ Served`).
- **D4 Detection.** Any window of public 5xx longer than `AlertAfter` probe periods ends with an
  alert raised.
- **D5 Client recovery.** The SPA's `image-fallback-memo` never keeps a URL marked dead longer than
  `DeadTTL` after the origin is healthy again, and it never marks a URL dead from a burst failure
  (many images failing at once = outage, not a missing file).
  `bugs/memo-poison.cfg` reproduces today's 24 h placeholders.
- **witness/** configs: the model can still reach `Reboot` → served, failover to k3s, alert → recover.

Every Model action maps to code or config with `file:line` in its README, as the other models do.

## Plan (phased; each phase ends green on check + TLC + verify)

1. **Spec** (this doc + `specs/tla/serving/`): model D1–D5 for the CDN path with the `bugs/`
   configs reproducing the 28/29 Oct failures. Exit: the fixed model passes, and every bug config
   reports its violation.
2. **Topology + check**: `infra/topology/` for the CDN path (tunnel, connectors, bindings,
   fallback, probes), plus the `pokoin-infra check` S1–S6 tests. Exit: the check rejects today's live
   setup (S2 on pi-home, S4 everywhere) and accepts the fixed data.
3. **Render + plan**: render pi-home hosts + cloud-init template + `cloudflared-cdn` drop-in
   (`ExecCondition` origin check) + k3s fragments, with golden tests. `plan` diffs against live
   pi-home and nezopt read-only.
4. **Apply + verify**: apply to pi-home behind the deploy guard. `verify` probes go into both
   sentinels, and a reboot drill on the Pi must stay 200 throughout (D1/D2 in the real world).
5. **Client**: make `image-fallback-memo` follow D5, bump the key to `v2` so poisoned entries
   are dropped, and add unit tests generated from the model's traces.
6. **Widen**: `api.pokoin.com` LB (pools, monitor, Pi/NEZ split), sync edges (overflow sync,
   poko-video, replica), then the remaining `install-*` scripts. Each script is folded into
   render/apply or listed as an exception.

Implementation runs on the delegation lane (`lane run --category deep`), one phase per run, with the
check command in each spec. Each run gets `diffgate`, `cargo test`, `specs/tla/run.sh` (via
`verify-gate`) and a live `verify`.

## Open questions for the owner

- Scope of phase 6: all hosts, Oracle included, or Pi + nezopt only?
- Cloudflare: may the pipeline **write** tunnel ingress and LB config through the API (a token in
  Infisical), or stay read-only (drift detection) with changes made by hand in the dashboard?
- TLA+ only, or also a Stateright model in Rust next to the crate (cheaper to keep in sync with code)?
