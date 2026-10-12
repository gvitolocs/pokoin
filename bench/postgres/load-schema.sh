#!/usr/bin/env bash
# Replay the marketplace schema the way the writer got it: every numbered
# migration from CardVault's oracle-postgres/schema and this repo's
# scripts/sql (this repo's copy wins when both have the same file name), plus
# this repo's unnumbered schema files (listing pipeline, weights, set counts),
# after bench/postgres/base-stubs.sql. Each file runs with ON_ERROR_STOP.
# Files run in name order; failed ones are retried in further passes until a
# pass applies nothing new (some files depend on later ones). The report lists
# what still fails on an empty database (data fixes that need rows, objects
# only production has) so the result can be judged, not assumed.
#
#   bench/postgres/load-schema.sh <psql> <conninfo> <cardvault-checkout> <report.tsv>
set -uo pipefail
psql=${1:?psql binary} conn=${2:?conninfo} cardvault=${3:?cardvault checkout} report=${4:?report path}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
schema=$cardvault/pokemon_card_vault/oracle-postgres/schema

declare -A pick
for f in "$schema"/[0-9]*.sql; do pick[$(basename "$f")]=$f; done
for f in "$repo"/scripts/sql/[0-9]*.sql; do pick[$(basename "$f")]=$f; done
mapfile -t pending < <(printf '%s\n' "${!pick[@]}" | sort -V)
for f in listing-pipeline.sql listing-weight-formulas.sql marketplace-set-catalog-counts.sql; do
  pick[$f]=$repo/scripts/sql/$f
  pending+=("$f")
done

"$psql" "$conn" -X -q -v ON_ERROR_STOP=1 -f "$here/base-stubs.sql" >/dev/null || exit 1

declare -A error
applied=0
for pass in 1 2 3 4 5; do
  next=()
  for name in "${pending[@]}"; do
    if out=$("$psql" "$conn" -X -q -v ON_ERROR_STOP=1 -f "${pick[$name]}" 2>&1 >/dev/null); then
      applied=$((applied + 1))
      unset 'error[$name]'
    else
      error[$name]=$(grep -m1 'ERROR' <<<"$out" | sed 's/^.*ERROR: *//' | cut -c1-160)
      next+=("$name")
    fi
  done
  [[ ${#next[@]} -eq ${#pending[@]} ]] && break
  pending=("${next[@]}")
done

{
  for name in $(printf '%s\n' "${!pick[@]}" | sort -V); do
    if [[ -v "error[$name]" ]]; then
      printf 'FAIL\t%s\t%s\n' "$name" "${error[$name]}"
    else
      printf 'ok\t%s\n' "$name"
    fi
  done
} >"$report"
echo "schema: $applied of ${#pick[@]} files applied, ${#error[@]} still fail on an empty database (see $report)"
