# Deploying pokoin-web (production)

One path, one line of history. Several agent sessions work on this repo at the
same time; this page is the rule they all follow. Scan Connect's multi-host
rollout: [SCAN_CONNECT.md](SCAN_CONNECT.md#production-deployment).

**Live host since 2026-10-04: Cloudflare Workers Static Assets** (`pokoin-web`,
assets-only, see [WEB_HOST.md](WEB_HOST.md)). `scripts/deploy-web.sh` is the
**Vercel rollback path only** — it does not publish the live site. Publish an exact
`origin/main` commit on nezopt with `scripts/publish-web.sh` (each step, and why the
upload carries the previous releases' chunks:
[WEB_HOST.md#deploying-2026-10-14](WEB_HOST.md#deploying-2026-10-14)):

```bash
scripts/publish-web.sh                         # git archive origin/main, build, carry chunks, upload (no traffic)
# check the printed Version Preview URL (short links, /, /marketplace, app assets), then:
scripts/publish-web.sh --promote <version-id>  # wrangler versions deploy <id>@100%
```

Do not run `wrangler versions upload` on a bare `build-web.sh` output: without
`scripts/carry-web-release-chunks.mjs` the upload lacks the previous release's chunks,
and pages blank for a minute or two after the deploy.

Rollback: `scripts/publish-web.sh --promote <previous version>`
(`wrangler deployments list --name pokoin-web` shows the history).
Every promote prints `publish-web: N of M retained versions were uploaded through the gate`;
a version id this host never recorded is still promoted with a warning while that list cannot
be read or `N < M`, and once `N = M` — every retained version went through the CI gate — such an
id is refused and `versions deploy` is never called ([CI.md](CI.md), "Deploy gate").

## The rule

1. **Integrate on `main`.** Branch or worktree for work, then merge into
   `main` and `git push origin main`. Production only ever runs a commit that is
   on `origin/main`.
2. **Deploy with `scripts/deploy-web.sh` on nezopt.** Never `vercel --prod`
   from a branch, a dirty checkout, or a copied directory.
   A commit ships only when `scripts/require-ci-green.sh` passes for it: its
   required GitHub checks are green, and this checkout's own gate and deploy
   scripts are byte-identical to `origin/main`'s (docs/CI.md, "Deploy gate").
3. **One checkout per agent.** Use `git worktree add` for parallel work. In a
   checkout another agent may be using, never `git stash`, `git reset --hard`,
   `git checkout -- .`, or `git add -A` / `git commit -a` — they move other
   agents' uncommitted files.

`scripts/deploy-web.sh [commit]` enforces 1–2: the commit must be on
`origin/main` and must contain the commit production runs (Vercel deployment
meta `gitCommitSha`, or `githubCommitSha` for older git builds). It builds a
`git archive` of the commit plus an allowlist of gitignored inputs
(`download/extension.zip`), runs `node --test market/src/*.test.js` and the Solid
tests (`cd solid && npm test`), deploys
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
node --test market/src/*.test.js && (cd solid && npm test)
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
| Marketplace Postgres **writer** | nezopt Docker `pokoin-marketplace-postgres-15t` (`192.168.178.55:25432`) | Schema migrations **here only** ([what a new migration file must say](#writer-migrations-the-header-a-new-file-needs)); Pi replica follows. Never migrate on the replica. Postgres image updates: [POSTGRES_VERSION.md](POSTGRES_VERSION.md). |
| Phone scanner (`scan.pokoin.com`) | Oracle peer1 Caddy `file_server` over `/opt/pokoin-cardscan/web` | Source is `pokoin-scanner/service/web`; deploy exact scanner commits with `deploy/deploy.py phone`, with backup and byte verification. Recognition calls the Pi API. |
| Silver extension download (`pokoin.com/extension.zip`, `/extension`) | SPA page `solid/src/pages/ExtensionDownload.jsx`; the zip only comes from `GET api.pokoin.com/api/extension-download` (Rust `pokoin-commerce` handlers/extension.rs: 401 without a Firebase token, 403 unless admin / role silver / silverUntil > now) | Copy `pokoin-extension-<version>.zip` into the Pi private dir `/srv/pokoin/extension/` (never the CDN or static assets; the highest version is served). `scripts/nezopt-k3s.sh sync` rsyncs it to the overflow pods, which mount it at the same path. |
| Extension download (`pokoin.com/download/extension.zip`) | Static `_redirects` 302 on `pokoin-web` to `https://cdn.pokoin.com/downloads/pokemon-card-extension-<version>.zip` (Pi `/srv/pokoin/card-images/objects/downloads/`, owner `nes`) | Copy the new zip to that Pi directory and check it downloads with a matching sha256, bump `EXTENSION_ZIP` in `scripts/write-cloudflare-web-routing.mjs`, then publish `origin/main` as usual. Keep `download/extension.zip` (Vercel fallback) and the `vercel.json` header version in step. The R2 Worker `pokoin-extension-download` has had no routes since the Cloudflare cutover; on 2026-10-05 the URL was a 404. |

### Writer migrations: the header a new file needs

There is no migrator. A person copies the `docker exec … psql` line above out of this
page and applies one file by hand, to one of 27 databases (the writer
`pokoin_marketplace`, one satellite per game, and a few others), in whatever order the
file names suggest. So the name and the header of a file are the only apply
instructions it will ever have, and `scripts/check-migrations.sh` enforces them for
every file a change adds or edits under `scripts/sql/` and under `scripts/sql-reverts/`
([CI.md](CI.md), "Migration rules" row). A new migration is:

```sql
-- scripts/sql/145_<snake_case>.sql        the next number above the highest here
-- db: writer                             or: every-game | satellite:<game> | main
-- phase: expand                          or: contract
-- destructive: <what it removes, and why nothing still running needs it>
create index …;
```

- **The number** is the apply order and the only identifier the operator has. It must
  be above every number already in `scripts/sql/` — gaps are taken, because the same
  number space belongs to `cardvault`'s `oracle-postgres/schema` too. A date
  (`YYYYMMDD_…`), an unnumbered name, and a second file on a used number are refused;
  15 collisions and a renumber-after-merge (127 → 129) are what that costs today.
- **`-- db:`** says which database to open. Without it the file is applied by whoever
  remembers, and on the wrong database it either creates an orphan table or succeeds
  while doing nothing.
- **`-- phase:`** says when it may run. `expand` only adds, so it is safe before or
  after the code; `contract` removes or changes something the previous release still
  uses, so the code that stopped using it ships first — the order
  `2085d715` states ("Deploy the code first, then the migration").
- **`-- destructive:`** is required together with `contract`, whenever the file holds
  a `drop table`/`drop column`, `truncate`, a `delete from` without `where`, an
  `alter … type` or a `rename`. It has to say something (15 characters minimum)
  because it becomes the whole record of why that drop was safe to ship.
- **A migration changes the schema**: `create`, `alter`, `drop`, `comment on`,
  `grant`, `revoke` — or a `\gexec` driving them — at the start of a line. A file of
  only `insert`/`update`/`delete` is a data fix: it goes beside the tool that runs it
  (`scripts/sql-fixes/` is the name the check suggests for it; nothing creates that
  directory), not into a number space the operator replays in order.
- **A file that has once been on `main` is never edited, renamed or removed.** Add a
  new number. The one exception is a file whose header carried `-- migration: draft`
  when it merged: it has not been applied yet, so it may still change.

**Every new migration is undoable, or says why it is not** (rule (g), PK-C019). Either the
change adds its revert to `scripts/sql-reverts/` — named exactly like the migration, with
`.revert.sql` appended — or the migration's first 10 lines carry one line of at least 15
characters saying it is a ratchet:

```sql
-- revert: irreversible: the update rewrote 1.2 million rows no source keeps any more
```

An honest `irreversible` is worth more than a revert file nobody tested, and both are
written by the person who still knows what the migration touched. A revert is:

```sql
-- scripts/sql-reverts/145_<snake_case>.revert.sql  same number and name as the migration
-- reverts: scripts/sql/145_<snake_case>.sql        that one file, which must exist
-- db: writer                                       the migration's own `-- db:` target
-- destructive: <what this drops, and why nothing still running needs what 145 built>
begin;
set local lock_timeout = '3s';

do $$ begin
  if pg_is_in_recovery() then raise exception 'refusing to run on a replica'; end if;
end $$;
```

- **The file name is the link.** `145_foo.sql` ↔ `145_foo.revert.sql`; the `-- reverts:`
  line repeats it so a reader holding one file can find the other. Anything in that
  directory whose name does not end in `.revert.sql` is a finding (rule (i)): the
  directory holds reverts and nothing else.
- **`-- db:`** is compared against the migration's. A revert run on another database
  either stops on the first missing object or finds a same-named table there and drops
  it. When the migration predates the `-- db:` rule and names no target — `144` is one —
  any valid target is accepted and the check prints that it could not be compared, so
  confirm the host by hand.
- **The replica refusal is not decoration.** The Pi replica is one `psql` line from the
  writer, and a revert is run in a hurry after something already went wrong. Without the
  `raise`, every statement fails with `cannot execute … in a read-only transaction`,
  which reads like the migration having failed rather than like the wrong host. See
  `scripts/sql-reverts/144_listing_external_identity.revert.sql`.
- **`-- destructive:`** is required, and rule (d) is not: a revert drops by definition,
  so `-- phase: contract` would be true of every file there and says nothing.
- **A revert on `main` is never edited, renamed or deleted** — the same rule as a
  migration, because someone may already have run it. Land a corrected revert beside it
  and say which one was applied, in docs.
- Reverts are only ever asked for in the pull request that adds the migration; nothing
  retro-fits them, and rules (g)–(i) read only what a change adds or edits. The three
  `2026*_*.revert.sql` files that predate this rule stay in `scripts/sql/`, where they
  were applied from: a file never moves out of `scripts/sql/` once it is on `main`.

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
