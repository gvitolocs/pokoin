# Deploying pokoin-web (production)

One path, one line of history. Several agent sessions work on this repo at the
same time; this page is the rule they all follow. Scan Connect's multi-host
rollout: [SCAN_CONNECT.md](SCAN_CONNECT.md#production-deployment).

**Live host since 2026-10-04: Cloudflare Workers Static Assets** (`pokoin-web`,
assets-only, see [WEB_HOST.md](WEB_HOST.md)). `scripts/deploy-web.sh` is the
**Vercel rollback path only** — it does not publish the live site. Publish an exact
`origin/main` commit like this (nezopt, login shell for `wrangler`):

```bash
S=$(mktemp -d); git archive <origin/main sha> | tar -C "$S" -xf -; cd "$S"
scripts/build-web.sh                                    # dist-web/
node scripts/write-cloudflare-web-routing.mjs dist-web  # _redirects (≤100 rules) + _headers
wrangler versions upload -c wrangler.pokoin-web.jsonc --message "main <sha>"   # no traffic yet
# check the printed Version Preview URL (short links, /, /marketplace, app assets), then:
wrangler versions deploy <version-id>@100% --name pokoin-web -y
```

Rollback: `wrangler versions deploy <previous version>@100% --name pokoin-web -y`
(`wrangler deployments list --name pokoin-web` shows the history).

## The rule

1. **Integrate on `main`.** Branch or worktree for work, then merge into
   `main` and `git push origin main`. Production only ever runs a commit that is
   on `origin/main`.
2. **Deploy with `scripts/deploy-web.sh` on nezopt.** Never `vercel --prod`
   from a branch, a dirty checkout, or a copied directory.
3. **One checkout per agent.** Use `git worktree add` for parallel work. In a
   checkout another agent may be using, never `git stash`, `git reset --hard`,
   `git checkout -- .`, or `git add -A` / `git commit -a` — they move other
   agents' uncommitted files.

`scripts/deploy-web.sh [commit]` enforces 1–2: the commit must be on
`origin/main` and must contain the commit production runs (Vercel deployment
meta `gitCommitSha`, or `githubCommitSha` for older git builds). It builds a
`git archive` of the commit plus an allowlist of gitignored inputs
(`download/extension.zip`), runs `node --test market/src/*.test.js`, deploys
with `--meta gitCommitSha=…`, holds `/tmp/pokoin-web-deploy.lock`, checks that
`pokoin.com` points at the new commit, and re-points `test.pokoin.com` at the
same deployment (that alias can otherwise lag and serve an old review board). A production deployment
without a SHA must be compared by hand and accepted with
`ALLOW_UNTRACKED_PRODUCTION=<deployment id>`.

`vercel.json` sets `git.deploymentEnabled = false`: no push builds on Vercel —
not `main`, not PR branches. Since 2026-09-29 preview builds of every PR
(projects `web` and `pokoin-web-seller-blackpage`) kept exhausting the free
plan's 100 deployments / 24 h and blocked production deploys. Production goes
only through `scripts/deploy-web.sh` (Vercel CLI, unaffected by this setting);
preview a branch locally with `paseo script start web` instead.

## Why (2026-09-17)

Vercel deployment records for project `web` that day:

| UTC | Source | Built from | Effect on pokoin.com |
| --- | --- | --- | --- |
| 12:29 | GitHub integration | `main` ae05fb3 — committed in the shared checkout, sweeping another agent's in-progress Scan Connect files | older Scan Desk snapshot live |
| 14:41 | CLI `--prod`, dirty tree | branch `email-preferences`, after `git stash` of another agent's uncommitted QR work | `/email-preferences` live |
| 14:51 | GitHub integration | `main` b5eb582 | `/email-preferences` gone |
| 15:01 | CLI `--prod` | branch `bimi-svg` (based on b5eb582) | `/email-preferences` and Scan Connect dashboard gone |

Two mechanisms: production was "whoever deployed last" across branch builds and
`main` auto-deploys; and agents shared `/home/nez/Projects/pokoin-web`, so a
stash or a sweeping commit moved someone else's files. Separately, every
GitHub-built deployment served **404 for `/download/extension.zip`** because
the zip is gitignored — another reason production builds run on nezopt.

## Commands

```bash
# on nezopt, in your worktree
git fetch origin && git merge origin/main        # include everyone's work
node --test market/src/*.test.js
git push origin HEAD:main
scripts/deploy-web.sh                             # deploys HEAD
```

Rollback: redeploy an earlier `origin/main` commit is refused (it would not
contain production). Revert on `main` instead (`git revert`), push, deploy.
For an emergency, `vercel promote <previous deployment url>` from the Vercel
dashboard/CLI, then fix `main` before the next deploy.

## Hosts that are not Vercel

| Surface | Host | How |
| --- | --- | --- |
| Shared Pokoin API (`api.pokoin.com`) | Pi native `pokoin-rust-api.service`, `/srv/pokoin/rust/current`, loopback 18082 | `scripts/deploy-pokoin-rust.sh` from the exact `origin/main` commit ([RUST_RUNTIME.md](RUST_RUNTIME.md)). The old Node container is retired and its sources are removed. Scanner workers deploy separately from `pokoin-scanner`; see `SCAN_API.md`. |
| Marketplace Postgres **writer** | nezopt Docker `pokoin-marketplace-postgres-15t` (`192.168.178.55:25432`) | Schema migrations **here only**; Pi replica follows. Never migrate on the replica. |
| Phone scanner (`scan.pokoin.com`) | Oracle peer1 Caddy `file_server` over `/opt/pokoin-cardscan/web` | Source is `pokoin-scanner/service/web`; deploy exact scanner commits with `deploy/deploy.py phone`, with backup and byte verification. Recognition calls the Pi API. |
| Extension download (`pokoin.com/download/extension.zip`) | Static `_redirects` 302 on `pokoin-web` to `https://cdn.pokoin.com/downloads/pokemon-card-extension-<version>.zip` (Pi `/srv/pokoin/card-images/objects/downloads/`, owner `nes`) | Copy the new zip to that Pi directory and check it downloads with a matching sha256, bump `EXTENSION_ZIP` in `scripts/write-cloudflare-web-routing.mjs`, then publish `origin/main` as usual. Keep `download/extension.zip` (Vercel fallback) and the `vercel.json` header version in step. The R2 Worker `pokoin-extension-download` has had no routes since the Cloudflare cutover; on 2026-10-05 the URL was a 404. |

### Shared API change (example: Recently Seen)

```bash
# 1) Writer migration (nezopt primary — verify writer host first)
docker exec -i pokoin-marketplace-postgres-15t \
  psql -U pokoin_marketplace -d pokoin_marketplace -v ON_ERROR_STOP=1 \
  < scripts/sql/090_marketplace_user_recents_game.sql

# 2) Rust API release from origin/main (build steps: RUST_RUNTIME.md)
scripts/deploy-pokoin-rust.sh

# 3) Web SPA (separate)
scripts/deploy-web.sh
```

Every shared API handler is native Rust in `pokoin-rust/`; the per-handler
Node overlay scripts were removed with the Node backend (`deploy-scan-api.sh`
stays as a pokoin-scanner wrapper).
