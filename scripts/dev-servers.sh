#!/usr/bin/env bash
# pokoin-web dev-server map: port, PID, the checkout each server serves.
#
# Read-only: this never kills anything. Run it before starting a dev server
# to find a free port and to spot servers that belong to another workspace.
# Long-lived dev servers must NOT run from the canonical checkout
# (see AGENTS.md, docs/paseo-development.md).
set -euo pipefail

CANONICAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

printf '%-8s %-8s %-24s %s\n' "PORT" "PID" "KIND" "CWD"

ss -tlnp 2>/dev/null | awk 'NR>1 {print $4"|"$NF}' | while IFS='|' read -r addr users; do
  [[ "$addr" == *":"* ]] || continue
  port="${addr##*:}"
  for pid in $(grep -oE 'pid=[0-9]+' <<<"$users" | cut -d= -f2 | sort -u); do
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)" || continue
    case "$cmd" in
      *vite*|*webpack*|*"next dev"*|*turbopack*|*http-server*) ;;
      *) continue ;;
    esac
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || echo '?')"
    kind="worktree/other"
    case "$cwd" in
      "$CANONICAL"|"$CANONICAL"/*) kind="CANONICAL (not allowed)" ;;
      "$HOME"/.paseo/worktrees/*) kind="paseo worktree" ;;
    esac
    printf '%-8s %-8s %-24s %s\n' "$port" "$pid" "$kind" "$cwd"
  done
done

echo
echo "canonical: $CANONICAL"
echo "Start dev servers only inside your own Paseo/git worktree, on its PASEO_PORT."
