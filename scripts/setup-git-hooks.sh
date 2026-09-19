#!/usr/bin/env bash
# Activate the pokoin-web git hooks for THIS working tree only.
#
# Uses a per-worktree core.hooksPath (extensions.worktreeConfig), so the
# canonical-commit guard (.githooks/pre-commit) applies exactly to the
# checkout where you run this script — normally the canonical checkout —
# and leaves linked Paseo/git worktrees untouched (they keep default hooks
# and commit normally).
#
# Run once per clone:   scripts/setup-git-hooks.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
git config extensions.worktreeConfig true
git config --worktree core.hooksPath .githooks
echo "pokoin-web hooks active for $(pwd -P) (per-worktree core.hooksPath=.githooks)"
echo "Linked worktrees are unaffected. Escape hatch: POKOIN_ALLOW_CANONICAL_COMMIT=1 git commit"
