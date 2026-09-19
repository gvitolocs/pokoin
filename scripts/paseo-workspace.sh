#!/usr/bin/env bash
# Create (or reuse) an isolated Paseo worktree for pokoin-web.
#
#   scripts/paseo-workspace.sh <slug>          # branch feature/<slug>
#
# Prints the worktree path to cd into. Paseo is the only worktree manager
# this repository uses; see docs/paseo-development.md. Requires the paseo
# CLI with its daemon running (`paseo status`).
set -euo pipefail

command -v paseo >/dev/null || {
  echo "paseo CLI not found on PATH (install per https://paseo.sh or run 'paseo onboard')" >&2
  exit 1
}
paseo status >/dev/null 2>&1 || {
  echo "paseo daemon is not reachable (try: paseo start)" >&2
  exit 1
}

slug="${1:?usage: scripts/paseo-workspace.sh <slug>   (e.g. sold-graph-fix)}"
slug="${slug#feature/}"
branch="feature/$slug"

# Reuse an existing workspace whose branch or slug matches, else create one.
if paseo workspace ls 2>/dev/null | grep -qE "$slug"; then
  echo "Reusing existing Paseo workspace for '$slug':"
  paseo workspace ls 2>/dev/null | grep -E "$slug" || true
else
  paseo workspace create \
    --isolation worktree \
    --mode branch-off \
    --new-branch "$branch" \
    --worktree-slug "$slug" \
    --base origin/main
  echo "Created Paseo workspace for '$slug' (branch $branch)."
fi

echo
echo "Active workspaces:"
paseo workspace ls || true
echo
cat <<'EOF'
Next:
  cd <worktree path printed above>
  paseo script start web      # vite on the Paseo-assigned port (optional)
  git status                  # confirm you are on your own branch
EOF
