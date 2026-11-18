#!/usr/bin/env bash
# Activate the pokoin-web git hooks for THIS working tree only.
#
# Uses a per-worktree core.hooksPath (extensions.worktreeConfig), so the
# canonical-commit guard (.githooks/pre-commit), the staged secret scan and the
# pre-push guard (.githooks/pre-push: main takes only a commit whose required CI
# checks are already green, and every published commit is secret-scanned) apply
# exactly to the checkout where you run this script — normally the canonical
# checkout — and leave linked Paseo/git worktrees untouched (they keep default
# hooks and commit normally).
#
# Run once per clone:   scripts/setup-git-hooks.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
git config extensions.worktreeConfig true
git config --worktree core.hooksPath .githooks
echo "pokoin-web hooks active for $(pwd -P) (per-worktree core.hooksPath=.githooks): pre-commit (staged secrets, canonical checkout) and pre-push (secret scan of what is published, CI gate on refs/heads/main)"
echo "Linked worktrees are unaffected. Escape hatch: POKOIN_ALLOW_CANONICAL_COMMIT=1 git commit. git push --no-verify skips pre-push, but the deploy entry points run scripts/require-ci-green.sh again."
