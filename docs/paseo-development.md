# Paseo development

Paseo provides isolated Git worktrees for concurrent coding agents. Each
workspace gets its own checkout, branch, and supervised Vite service, so agents
can work in parallel without sharing a source tree or development port.

## Workflow

```text
origin/main
    ↓
Paseo worktree
    ↓
agent
    ↓
local unique preview
    ↓
tests/review
    ↓
integration
    ↓
GitHub
    ↓
Vercel
```

GitHub is remote history, integration, and CI. Vercel is the preview and
production deployment target after integration. Paseo is the active
multi-agent development environment; creating or completing a workspace does
not push, merge, or deploy anything.

## Repository commands

This repository has no root `package.json`. The Vite application and npm
lockfile are under `market/`.

| Operation | Command |
| --- | --- |
| Install | `cd market && npm ci` |
| Normal development | `cd market && npm run dev` |
| Build | `bash scripts/build-web.sh` |
| Marketplace build only | `cd market && npm run build` |
| Tests | `node --test market/src/*.test.js` |
| Lint | Not configured |
| Typecheck | Not configured |

The production-shaped build also installs dependencies and generates the
landing output, so use it only when that full output is needed. `paseo.json`
uses the same commands rather than adding new package scripts.

## Paseo configuration

The root `paseo.json` defines:

- a worktree setup hook that runs `npm ci` in `market/`;
- a `web` service that invokes the existing Vite `dev` script;
- the existing repository test command;
- the existing full build command.

The service receives its port from Paseo:

```text
--port $PASEO_PORT --host $HOST --strictPort
```

The Vite config keeps its normal default (`5174`) for non-Paseo development,
while the command-line arguments override it in a Paseo workspace. Never
replace `$PASEO_PORT` with a fixed port in `paseo.json`.

Useful variables supplied by Paseo are:

| Variable | Meaning |
| --- | --- |
| `PASEO_SOURCE_CHECKOUT_PATH` | Original source checkout |
| `PASEO_WORKTREE_PATH` | Current isolated worktree |
| `PASEO_BRANCH_NAME` | Current worktree branch |
| `PASEO_PORT` | Current service's assigned port |
| `PASEO_URL` | Current service's daemon proxy URL |
| `HOST` | Host address Paseo expects the service to bind |
| `PASEO_SERVICE_<NAME>_PORT` | Peer service port, when another service exists |
| `PASEO_SERVICE_<NAME>_URL` | Peer service proxy URL, when another service exists |

There is currently only one local service in this repository: the Vite web
service. The API, card scanner, chain RPC, Firebase, and CDN are external
services, so no fake Paseo peer services are declared.

## Environment and shared state

Fresh worktrees do not receive ignored files. The repository ignores
`market/.env`, `market/.env.local`, and `market/.env.*.local`; Paseo does not
copy them automatically. This is intentional: local environment files can
contain credentials or point at shared production-like services. If a local
worktree needs one, create it through the machine's approved secret/config
mechanism rather than committing it or copying production secrets into the
repository.

| Resource | Isolated per worktree? | Evidence / consequence |
| --- | --- | --- |
| Source files | Yes | Paseo creates a separate Git worktree |
| Git branch | Yes | Paseo assigns a branch per worktree |
| `node_modules` | Yes | `npm ci` runs inside each `market/` worktree |
| Frontend port | Yes | The `web` service binds to `$PASEO_PORT` |
| Paseo preview URL | Yes | Paseo proxies each service by workspace/branch |
| Firebase Auth | No | `market/src/auth.jsx` uses the shared `pokoin` Firebase project |
| Firestore | No | Account, order, collection, and wallet-related data use shared backend state |
| Marketplace API/PostgreSQL | No | `/api` proxies to `api.pokoin.com` unless `POKOIN_API_PROXY` is explicitly set |
| Meilisearch/Valkey/CDN | No | These are remote infrastructure behind the API/image proxies |
| CardTrader/Cardmarket/Vinted | No | Marketplace integrations are external services |
| Stripe/webhooks | Not used by this frontend dev service | Payment integrations belong to the sibling CardVault/API service |
| OAuth callbacks | Not configured here | No repository-local OAuth callback server was found |

Paseo isolates files and ports, not external accounts, databases, or API
side-effects. Use test accounts and a deliberately configured local API proxy
for work that writes shared backend state.

## Common operations

From the source checkout, current Paseo CLI commands are:

```bash
paseo project create
paseo workspace create --isolation worktree --mode branch-off \
  --new-branch feature/example --worktree-slug example --base origin/main
paseo script start web
paseo script ls
paseo run --workspace <workspace-id> "implement the task"
paseo workspace ls
paseo workspace archive <workspace-id>
```

Use `paseo script ls` to obtain the service proxy URL and assigned port. These
commands target the already-running Paseo daemon; they do not configure
systemd, GitHub, Vercel, or deployment infrastructure.

## No repo-local MCP server

Paseo's agent orchestration and MCP tools come from its daemon. This repository
does not add a `.paseo-mcp.json`, custom MCP server, or fake integration.

## Canonical checkout policy

`/home/nez/Projects/pokoin-web` is the canonical **integration/deployment**
checkout. It is not a development workspace:

- The canonical checkout must normally remain **clean**: no uncommitted
  feature work, no generated artifacts, no long-lived dev servers.
- All code changes happen in a Paseo worktree. One agent, one workstream,
  one worktree.
- Integration and deployment operations happen in the canonical checkout:
  merging to `main`, `scripts/deploy-web.sh`, infra jobs. Everything else
  belongs in a worktree.

### Standard agent lifecycle

```text
agent starts
  → dedicated Paseo worktree   (scripts/paseo-workspace.sh <slug>)
  → edit / test / commit there (own branch, own $PASEO_PORT)
  → integrate intentionally    (merge / fast-forward into main, push origin/main)
  → production deployment      (scripts/deploy-web.sh of the exact origin/main SHA)
```

- **One agent/workstream per worktree.** Never share a worktree between two
  concurrent tasks; collisions are exactly what this setup prevents.
- **Dev-server ports are per worktree.** Use the Paseo-assigned
  `$PASEO_PORT`; run `scripts/dev-servers.sh` to see which ports/PIDs are
  already owned, and never kill another workspace's server.
- **Identify your current worktree** with
  `git rev-parse --show-toplevel`. If it prints
  `/home/nez/Projects/pokoin-web`, you are in the canonical checkout —
  create a worktree before editing source
  (`git rev-parse --absolute-git-dir` equals
  `git rev-parse --git-common-dir` only in the main worktree).
- **Finished worktree:** remove it with `paseo workspace archive
  <workspace-id>` (or `git worktree remove <path>` for plain git
  worktrees) after its branch is integrated or abandoned.
- **If the canonical checkout is already dirty** because of another agent:
  do not touch those files, do not `git clean`/stash/reset them, do not
  stage them. Inspect `git status --porcelain`, stage only the paths you
  own by explicit name, and say what you left alone.

## Hooks and guards

- `.githooks/pre-commit` rejects commits made in the canonical main
  worktree. Intentional integration/maintenance commits bypass it with
  `POKOIN_ALLOW_CANONICAL_COMMIT=1`. Commits in linked worktrees are never
  blocked. Enable per clone/worktree: `scripts/setup-git-hooks.sh`
  (sets a per-worktree `core.hooksPath`, so linked worktrees keep default
  hooks and are unaffected).
- `scripts/deploy-web.sh` prints a prominent warning when the canonical
  checkout is dirty and names the un-deployed entries. Deployed contents
  are always a `git archive` of the exact `origin/main` commit plus the
  explicit `UNTRACKED_INPUTS` allowlist, so a dirty tree cannot change
  what production runs — it only means un-integrated work exists.
- `scripts/dev-servers.sh` maps running dev servers to PID, port, and the
  checkout they serve (canonical vs Paseo worktree). Read-only.

## Isolation by construction

Instructions alone cannot stop a manually opened IDE or CLI session from
editing the wrong checkout. The reliable path is to let Paseo create the
workspace when the agent is created:

```bash
paseo run --new-workspace worktree --worktree-mode branch-off \
  --worktree-slug my-feature --new-branch feature/my-feature \
  --base origin/main "implement the task"
```

The agent is then born inside its worktree and never sees the canonical
checkout. Launch harnesses through this command (or the wrapper
`scripts/paseo-workspace.sh`) rather than opening
`/home/nez/Projects/pokoin-web` directly; the pre-commit hook and the
deploy warning are backstops, not the primary control.
