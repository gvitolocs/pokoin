#!/usr/bin/env bash
# Find seller listings tagged `pokemon` whose card is another game's, and write
# the SQL that retags them. Read-only: it never runs that SQL.
#
#   scripts/retag-misgamed-listings.sh [--seller UID] [--source SOURCE] [--out DIR]
#
# A row is retagged when its card id is not in the Pokémon catalog and exactly
# one satellite catalog holds that id under the listing's card name (the rule
# create_listing applies to new rows, pokoin-rust commerce `listing_game`).
# 200000000+ synthetic ids repeat across Cardmarket-only games (200001768 is in
# eight catalogs), so the id alone never decides. Rows no catalog vouches for
# are listed as unresolved and left alone.
#
# Writes to DIR (default: a new mktemp dir):
#   retag.sql       begin; update …; rollback;  review it, then change rollback
#                   to commit and run it on the writer to apply.
#   resolved.tsv    id, card_id, card_name, from, to, image dir, source, seller, status
#   unresolved.tsv  id, card_id, card_name, holders, source, seller, status
#
# Runs on nezopt against the writer container (PG_CONTAINER, PG_USER).
set -euo pipefail

container="${PG_CONTAINER:-pokoin-marketplace-postgres-15t}"
pg_user="${PG_USER:-pokoin_marketplace}"
seller=""
source_filter=""
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --seller) seller="${2:?--seller needs a uid}"; shift 2 ;;
    --source) source_filter="${2:?--source needs a value}"; shift 2 ;;
    --out) out="${2:?--out needs a directory}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
out="${out:-$(mktemp -d "${TMPDIR:-/tmp}/retag-misgamed.XXXXXX")}"
mkdir -p "$out"

psql_at() { docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U "$pg_user" -d "$1" -At -F $'\t'; }
literal() { printf "'%s'" "${1//\'/\'\'}"; }

# pokoin-rust/crates/commerce/src/game.rs SATELLITE_GAMES, in that order.
games=(magic yugioh flesh_and_blood digimon dragon_ball_super vanguard one_piece lorcana
  star_wars union_arena riftbound gundam sorcery palworld cyberpunk weiss_schwarz final_fantasy
  force_of_will world_of_warcraft battle_spirits_saga star_wars_destiny dragon_born
  my_little_pony the_spoils)

filters=""
[ -n "$seller" ] && filters+=" and l.seller_uid = $(literal "$seller")"
[ -n "$source_filter" ] && filters+=" and l.source = $(literal "$source_filter")"

# 1. Pokémon-tagged rows whose numeric card id the Pokémon catalog lacks.
psql_at pokoin_marketplace > "$out/candidates.tsv" <<SQL
select l.id, l.card_id, l.card_name,
       coalesce(replace(substring(l.card_image_url from '^https://cdn\.pokoin\.com/([a-z0-9-]+)/'), '-', '_'), ''),
       l.source, l.seller_uid, l.status
  from public.marketplace_user_listings l
 where coalesce(nullif(l.marketplace_game, ''), 'pokemon') = 'pokemon'
   and l.card_id ~ '^[0-9]{1,18}\$'
   and not exists (select 1 from public.marketplace_search_candidates c where c.card_id = l.card_id::bigint)
   $filters
 order by l.created_at, l.id;
SQL
candidates=$(wc -l < "$out/candidates.tsv")
echo "pokemon-tagged rows whose card id the Pokémon catalog lacks: $candidates"
if [ "$candidates" -eq 0 ]; then
  echo "nothing to retag"; exit 0
fi
ids=$(cut -f2 "$out/candidates.tsv" | sort -u | paste -sd, -)

# 2. Every satellite catalog's name for those ids, as SQL value tuples.
: > "$out/holders.sql"
existing=$(psql_at postgres <<< "select datname from pg_database where datname like 'pokoin\_%'")
for game in "${games[@]}"; do
  grep -qx "pokoin_$game" <<< "$existing" || continue
  psql_at "pokoin_$game" >> "$out/holders.sql" <<SQL
select format('(%L, %L, %L)', '$game', card_id::text, coalesce(name, ''))
  from public.marketplace_search_candidates where card_id = any('{$ids}'::bigint[]);
SQL
done
holders=$(wc -l < "$out/holders.sql")
echo "satellite catalog rows holding those ids: $holders"
[ "$holders" -gt 0 ] || { echo "no satellite holds any of them"; exit 0; }

# 3. Decide every candidate with the create_listing rule, in one read query.
values=$(paste -sd, "$out/holders.sql")
rows=$(awk -F'\t' -v OFS=', ' '{
  for (i = 1; i <= 7; i++) { gsub(/\x27/, "\x27\x27", $i); $i = "\x27" $i "\x27" }
  print "(" $1, $2, $3, $4, $5, $6, $7 ")"
}' "$out/candidates.tsv" | paste -sd, -)
psql_at pokoin_marketplace > "$out/decided.tsv" <<SQL
with holders(game, card_id, name) as (values $values),
rows(id, card_id, card_name, image_game, source, seller_uid, status) as (values $rows),
decided as (
  select r.*,
         (select string_agg(h.game, ',' order by h.game) from holders h where h.card_id = r.card_id) as holding,
         (select array_agg(h.game) from holders h where h.card_id = r.card_id
            and (lower(regexp_replace(r.card_name, '[^[:alnum:]]+', '', 'g')) = ''
                 or lower(regexp_replace(h.name, '[^[:alnum:]]+', '', 'g'))
                    = lower(regexp_replace(r.card_name, '[^[:alnum:]]+', '', 'g')))) as named
    from rows r
)
select id, card_id, card_name, image_game, source, seller_uid, status, coalesce(holding, ''),
       case when cardinality(named) = 1 then named[1] else '' end
  from decided;
SQL

awk -F'\t' -v OFS='\t' -v out="$out" '
  $9 != "" { print $1, $2, $3, "pokemon", $9, $4, $5, $6, $7 > (out "/resolved.tsv"); next }
  { print $1, $2, $3, $8, $5, $6, $7 > (out "/unresolved.tsv") }
' "$out/decided.tsv"
touch "$out/resolved.tsv" "$out/unresolved.tsv"

{
  echo "-- Generated $(date -u +%FT%TZ) by scripts/retag-misgamed-listings.sh${seller:+ --seller $seller}${source_filter:+ --source $source_filter}."
  echo "-- Retags $(wc -l < "$out/resolved.tsv") pokemon-tagged listings to the one satellite catalog holding the card under its name."
  echo "-- Dry run: it ends in rollback. Check the UPDATE count, then change rollback to commit to apply."
  echo "begin;"
  echo "update public.marketplace_user_listings l"
  echo "   set marketplace_game = v.game, updated_at = now()"
  echo "  from (values"
  awk -F'\t' '{ printf "%s    (\x27%s\x27, \x27%s\x27, \x27%s\x27)", (NR > 1 ? ",\n" : ""), $1, $2, $5 } END { print "" }' "$out/resolved.tsv"
  echo "  ) as v(id, card_id, game)"
  echo " where l.id = v.id::uuid and l.card_id = v.card_id and l.marketplace_game = 'pokemon';"
  echo "-- expect: UPDATE $(wc -l < "$out/resolved.tsv")"
  echo "rollback;"
} > "$out/retag.sql"

echo
echo "resolved (retag to → rows, by source and seller):"
awk -F'\t' '{ n[$5 "\t" $7 "\t" $8 "\t" $9]++ } END { for (k in n) print "  " n[k] "\t" k }' "$out/resolved.tsv" | sort -k2
echo "resolved rows whose image directory names another game: $(awk -F'\t' '$6 != "" && $6 != $5' "$out/resolved.tsv" | wc -l)"
echo "unresolved (left alone): $(wc -l < "$out/unresolved.tsv")"
awk -F'\t' '{ n[$5 "\t" $6]++ } END { for (k in n) print "  " n[k] "\t" k }' "$out/unresolved.tsv" | sort -k2
echo
echo "wrote $out/retag.sql (ends in rollback), resolved.tsv, unresolved.tsv"
