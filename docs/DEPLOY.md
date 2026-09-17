# Deploying pokoin-web (production)

One path, one line of history. Several agent sessions work on this repo at the
same time; this page is the rule they all follow. Scan Connect's multi-host
rollout: [SCAN_CONNECT.md](SCAN_CONNECT.md#production-deployment).

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

`vercel.json` sets `git.deploymentEnabled.main = false`: pushes to `main` do
not deploy by themselves. Other branches still get preview deployments.

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
| Oracle API (`api.pokoin.com`) | Pi, Docker `pokoin-oracle-api`, `/srv/pokoin/api/current` → release dir | new release dir + symlink + `docker restart` (see `scripts/deploy-scan-connect.sh api`) |
| Marketplace Postgres writer | nezopt Docker `pokoin-marketplace-postgres-15t` (`192.168.178.55:25432`) | migrations here only; the Pi replica follows |
| Phone scanner (`scan.pokoin.com`) | Oracle peer1 Caddy `file_server` over `/opt/pokoin-cardscan/web` | back up, replace files; Caddy `/etc/caddy/Caddyfile` |
