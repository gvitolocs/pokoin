# cdn.pokoin.com serving path (serving pipeline, phase 1)

`Model.tla` models the `cdn.pokoin.com` serving path as it stood on
2026-10-29 and as [`docs/SERVING_PIPELINE.md`](../../../docs/SERVING_PIPELINE.md)
redesigns it. The remote-managed Cloudflare tunnel `pokoin-cdn` has one ingress
rule, `http://pokoin-cdn-origin:18081`, and two connectors: the Pi, where the
name resolves only through `/etc/hosts`, and nezopt k3s, where a Service binds
it. Cloudflare sends each request to any **connected** connector and never
looks at the origin behind it. Around the tunnel the model has the sentinel's
probe and alert and the SPA's image-fallback memo.

The model has five feature flags, one per fix, and `Fixed` requires all of them
(`ASSUME`). `Fixed = TRUE` is the pipeline design. `Fixed = FALSE` with every
flag off is the system of the 28 and 29 Oct incidents.

| Flag | On (pipeline design) | Off (today) |
| --- | --- | --- |
| `PersistBinding` | `Apply` renders the binding into `/etc/hosts` **and** the cloud-init template | the binding is a live-only hand edit of `/etc/hosts` |
| `OriginGatedConnector` | `cloudflared-cdn` starts only behind an `ExecCondition` that resolves the name and fetches through the origin; a watchdog stops it within `WatchdogTicks` periods of the origin going bad | the connector starts and stays connected whatever happens to its origin |
| `PublicProbe` | the sentinel's `verify` fetches a real object through the public URL (fails whenever some request could 5xx) | the sentinel checks units, ports and metrics only |
| `PathProbe` | `verify` also checks every connector path on its own: resolve the name on the host, fetch a real object through that host's origin, and check the connector is connected | nothing notices one leg down while the other serves |
| `BurstAwareMemo` | a page whose every requested image failed is treated as an outage and marks nothing; dead marks live `DeadTTL` | every image whose siblings all failed is `about:dead` for 24 h |

Findings: [`../FINDINGS.md`](../FINDINGS.md#cdnpokoincom-serving-path-serving-2026-10-29).

## What is modelled

One `Tick` is one sentinel period (5 min, `OnUnitActiveSec=5min`). Every
counter is bounded.

| Spec | Real system |
| --- | --- |
| `Pi`, `HostsFile = {Pi}` | `pi-home`: connector `cloudflared-cdn.service` (`cloudflared tunnel run --token-file …`). Origin: the Rust CDN in `pokoin-rust-api.service` on `127.0.0.1:18081` (`pokoin-rust/crates/edge/src/cdn.rs:486` `router`, `:577` `serve`) |
| `K3s` | nezopt `pokoin-k3s` container, namespace `pokoin-overflow`. Connector: Deployment `cloudflared-cdn` (`infra/k3s/pokoin-security.yaml:427`). Origin: Service `pokoin-cdn-origin` (`infra/k3s/pokoin-overflow.yaml:384`) → API pods' CDN listener `:8081` (`POKOIN_CDN_BIND`, `pokoin-overflow.yaml:212`) |
| `live[h]` | Pi: `pi-home:/etc/hosts` has `127.0.0.1 pokoin-cdn-origin`. K3s: the Service exists |
| `tmpl[h]` | Pi: `pi-home:/etc/cloud/templates/hosts.debian.tmpl` (the Pi's cloud-init config has `manage_etc_hosts: True`). K3s: the applied manifest `infra/k3s/pokoin-overflow.yaml` (always `TRUE`) |
| `up[h]` | the origin process answers on its CDN port |
| `conn[h]` | the connector is registered with Cloudflare (`cloudflared` `/ready`, `pokoin-security.yaml:468`, `:483`) |
| `Reboot(h)` | a power cycle. cloud-init rewrites `/etc/hosts` from the template on every boot (the plan's `CloudInitRegen`, folded in), and the origin and connector come up again later (`OriginRecover`, `ConnStart`) |
| `ManualEdit(h)` | the 28 Oct repair: the line typed into `/etc/hosts` only |
| `Drift(h)` | something outside the pipeline removes the binding from the live file **and** the template: an OS or cloud-init upgrade overwrites `hosts.debian.tmpl`, the Service is deleted, the host is reinstalled. Not fair, at most `MaxDrifts` per host, only on `CanDrift` hosts. Ghost `drifted[h]` is set by `Drift` and cleared by `Apply` |
| `Apply(h)` | `pokoin-infra apply <host>` (phase 4). Today there is no pipeline, so the "apply" is the same live-only hand edit. It runs on first deploy (`~applied[h]`) and again whenever the binding is incomplete while an alert is raised (`alerted /\ (~live[h] \/ ~tmpl[h])`) |
| `OriginCrash` / `OriginRecover` | `pokoin-rust-api.service` (Pi) or the `pokoin-api` pods (k3s) die and come back |
| `ConnStart(h)` | systemd or the Deployment starts `cloudflared`. Gated: an `ExecCondition=` like the existing `deploy/ops/nezopt-user/pi-dependent.d-60-pi-up.conf:4` (to be rendered in phase 3) |
| `ConnStop(h)` | the watchdog that stops a connector whose origin stopped answering (phase 3; it does not exist today) |
| `Request` | a public `GET https://cdn.pokoin.com/…`: Cloudflare picks any connected connector. 200 if its origin is up and resolvable, 502 if not, 530 (error 1033) with no connector |
| `Probe` | one `pokoin-ops sentinel` run. It fails on a dead origin process (always), on `PublicBad` (`PublicProbe`), or on any host whose path does not serve (`PathProbe`). Real code: (`tools/pokoin-ops/src/sentinel.rs:530` `run_checks`, Pi role `:573`, `api` metrics `:599`, failed `unit`s `:627`; timers `deploy/ops/pi/pokoin-sentinel.timer:6`, `deploy/ops/nezopt-user/pokoin-sentinel.timer:6`). Today it notices a dead origin process and nothing else. Fixed: plus `pokoin-infra verify` |
| `degraded[h]`, `servedSeen[h]` | whole consecutive periods in which h's path does not serve (`~(conn[h] /\ Healthy(h))`), counted like `outage`: a period in which h served at any point resets it |
| `streak`, `alerted`, `AlertAfter` | the sentinel's per-finding streak, which alerts at `streak >= confirm` (`sentinel.rs:175`). The checks use `confirm = 2`. The model has **one** streak and one alert for every probe failure, so a degraded path alerts after the same `AlertAfter` periods as a public outage. Severity (`Sev::Crit` for public 5xx, `Sev::Warn` for one degraded path) is a phase-4 rendering choice. Both alert and both must be acted on, and the properties need nothing more |
| `PageLoad` | one page of `CardArt` images. Each URL is either `ImageOk` (`acceptIfScan`, `solid/src/components/CardArt.jsx:81`) or `ImageFail` (every sibling failed: `failCurrent`, `CardArt.jsx:63`). The image routes to any connected connector |
| `dead[u]`, `age[u]` | `rememberImageFallback(list[0], DEAD_IMAGE, { keepMs: 24 h })` (`CardArt.jsx:73`; also `ExpansionMark.jsx:37`, `SetGuideGrid.jsx:35`), `market/src/image-fallback-memo.js:64`. A dead URL is not requested again (`CardArt.jsx:49`) |
| `MemoExpire(u)` | `load()` drops an entry older than its `keepMs` (`image-fallback-memo.js:35`) |
| `DeadKeep` | today's 24 h. Any value `> DeadTTL` gives the same counterexample; the configs use 3 periods |
| `Missing` | images whose file really is absent, so the memo still has a job |

## What is abstracted away

- **Cloudflare's choice of connector** is nondeterministic. The real
  scheduler prefers a nearby, low-latency connector. On 28 and 29 Oct that was
  the Pi for practically every request, which nondeterminism covers.
- **The two `cloudflared-cdn` replicas** in k3s are one connector, and the API
  pods behind the Service are one origin. They fail together for this model's
  purposes (the Service has no endpoints, or the namespace is down).
- **The k3s → Pi fallback** for objects the nezopt mirror lacks
  (`POKOIN_CDN_FALLBACK_ORIGIN`, `pokoin-overflow.yaml:214`, via
  `deploy/ops/nezopt-user/pokoin-pi-cdn-tunnel.service`) is not modelled. The
  mirror is assumed complete. The one-hop loop guard (`cdn.rs:534`
  `FALLBACK_AGENT`, `:588` `nested`) is static invariant S5, not dynamics.
- **Apply runs when there is a reason**: on first deploy, and on a raised alert
  while the binding is incomplete. Weak fairness on `Apply` is the assumption
  that **an alert is acted on**: the operator (or a future automated
  reconciler) runs `pokoin-infra apply`. Without the alert conjunct, fairness
  would re-apply today's live-only edit after every reboot, a repair nobody
  performs. That would make today's system heal itself and hide the D3
  counterexample. Removing the binding is `Drift`. `ManualEdit` only adds it.
- **Connector crashes outside a reboot** are not modelled. cloudflared
  reconnects by itself.
- **The 7-day fallback entries** of the memo (a sibling that loaded) cannot be
  created by an outage, because no sibling loads then. Only dead marks are
  modelled. The siblings of one card collapse into one URL.
- **A page load is one atomic step**: the browser requests every image that is
  not marked dead at once, and the burst rule sees all the outcomes together.
- **Time** is whole sentinel periods. `WatchdogTicks = 1`, `AlertAfter = 2`,
  `DeadTTL = 1`, `DeadKeep = 3` (standing for 24 h). `Tick` cannot pass a
  deadline: the period's sentinel run, the watchdog bound, or a mark's expiry.
- **Environment.** `CanReboot`, `CanCrash` and `CanDrift` choose which hosts
  may reboot, lose their origin, or drift. The fixed configs allow all three on
  both hosts (`MaxDrifts = 2` in `Model.cfg`, 1 in `liveness.cfg`). The incident
  bug configs allow only what happened on 28 and 29 Oct (Pi reboots, no crashes,
  no drift), and `silent-degradation.cfg` allows only one Pi drift, so TLC's
  shortest counterexample is the incident itself.

## Properties

| Property | Plan | Meaning |
| --- | --- | --- |
| `RebootSafety` | D1 | once `Apply(h)` has run and h has not drifted since, `pokoin-cdn-origin` resolves on h in every later state, through any reboots and hand edits: `(applied[h] /\ ~drifted[h]) => live[h]`. Only an explicit `Drift` can break an applied binding, and detecting it is D4b's job |
| `NoFalseFailover` | D2 | a connected connector has a healthy, resolvable origin, **except for at most `WatchdogTicks` whole periods** after its origin went bad. That window is the watchdog's detection delay, and a request routed there inside it still gets a 502. `badFor[h]` counts it |
| `Availability` (liveness) | D3 | an origin that eventually stays up eventually serves through its connector for good, so requests are served 200. Premise: `<>[]up[h]` **and finitely many drifts** (`MaxDrifts`, a bound in the model). After the last drift, `PathProbe` raises the alert and `Apply`'s fairness restores the binding |
| `Detection` | D4 | more than `AlertAfter` whole periods in which some public request could get a 5xx imply the alert is raised |
| `RedundancyDetection` | D4b | more than `AlertAfter` whole periods in which one host does not serve imply the alert, even while the other host serves every request. A reboot shorter than that is expected and silent |
| `ClientRecovery` | D5 | an image that exists never stays dead more than `DeadTTL` periods while the CDN serves every request (`healthyDead`), and a page load with no healthy connector (an outage-wide burst) never creates a dead mark (`burstMarked`) |
| `TypeOK` | | types and counter bounds |

Fairness is weak fairness on `Tick`, `Probe`, `Apply`, `ConnStart`, `ConnStop`
and `MemoExpire`: time passes, the sentinel runs, the pipeline runs once,
systemd starts units, the watchdog acts, and entries expire. Reboots, crashes,
recoveries, hand edits, requests and page loads are environment events with no
fairness. D3's premise rules out an origin that is down for ever or reboots
for ever, and a binding that keeps drifting.

Each flag is necessary for exactly its own safety property. With all flags on
except one, `Model.cfg` violates that flag's property and no other (checked
2026-10-29 by dropping the property from the config). `PersistBinding` off also
breaks D3, and the other three flags off leave D3 intact.

## Configs

| Config | Expectation |
| --- | --- |
| `Model.cfg` | pipeline design, both hosts may reboot and crash, one existing and one missing image: D1, D2, D4, D5, `TypeOK` hold |
| `liveness.cfg` | pipeline design: D3 holds |
| `bugs/hand-hosts.cfg` | today: `RebootSafety` violated (hand edit → Pi reboot → name gone) |
| `bugs/hand-hosts-unavailable.cfg` | today: `Availability` violated (the Pi origin up for good, its connector connected, never a 200) |
| `bugs/connected-not-healthy.cfg` | today: `NoFalseFailover` violated (the Pi connector reconnects after the reboot with no binding) |
| `bugs/no-public-probe.cfg` | today: `Detection` violated (three periods of 502s from the Pi path, no alert) |
| `bugs/memo-poison.cfg` | today: `ClientRecovery` violated (images marked dead during the outage stay dead after K3s serves everything) |
| `witness/NeverServedAfterReboot.cfg` | the Pi reboots after `Apply` and serves a 200 again |
| `witness/NeverFailover.cfg` | the Pi origin is down and K3s serves the request |
| `witness/NeverAlertRecovered.cfg` | an alert is raised and later resolved |
| `witness/NeverDeadMark.cfg` | a really missing image is still remembered as dead |

Results are in [`../FINDINGS.md`](../FINDINGS.md#cdnpokoincom-serving-path-serving-2026-10-29).

Run: `specs/tla/run.sh serving` (add `--regressions` for the rest), through
`~/.local/bin/verify-gate` on nezopt.
