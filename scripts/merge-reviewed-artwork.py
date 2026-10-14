"""Back up and merge explicitly reviewed painting/version families on the primary.

Dry run by default. --apply requires the user-authorized reviewed evidence file.
Never edit prices, inventory, card identities, language or finish fields.
"""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path


def sql(command):
    remote = 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d pokoin_marketplace -At'
    return subprocess.check_output(['docker', 'exec', '-i', 'pokoin-marketplace-postgres-15t',
                                    'sh', '-c', remote], input=command, text=True)


def components(review):
    parent = {}
    def root(group):
        parent.setdefault(group, group)
        if parent[group] != group:
            parent[group] = root(parent[group])
        return parent[group]
    for edge in review['pairs']:
        if edge['decision'] != 'approve':
            continue
        a, b = edge['a'], edge['b']
        if not all(re.fullmatch(r'v[0-9]+', value, flags=re.ASCII) for value in (a, b)):
            raise ValueError('invalid public version identity')
        ra, rb = root(a), root(b)
        if ra != rb:
            first, second = sorted((ra, rb), key=lambda value: int(value[1:]))
            parent[second] = first
    return {group: root(group) for group in sorted(parent)}


def main(args):
    source = Path(args.review)
    review = json.loads(source.read_text())
    if not review.get('reviewed_all_pairs'):
        raise ValueError('all proposed edges must have explicit visual review')
    aliases = components(review)
    versions = ','.join("'" + group + "'" for group in aliases)
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=False)
    if sql("SELECT pg_is_in_recovery() OR current_setting('transaction_read_only')='on';").strip() != 'f':
        raise RuntimeError('refusing to write or prepare against a replica')
    cards = [json.loads(line) for line in sql(f"SELECT row_to_json(c) FROM marketplace_search_candidates c WHERE version IN ({versions}) ORDER BY card_id;").splitlines()]
    sets = [json.loads(line) for line in sql(f"SELECT row_to_json(s) FROM pokoin_version_sets s WHERE version IN ({versions}) ORDER BY version;").splitlines()]
    by_id = {str(row['card_id']): row for row in cards}
    for edge in review['pairs']:
        if edge['decision'] == 'approve':
            for pid, version in zip(edge['public_ids'], (edge['a'], edge['b'])):
                if pid not in by_id or by_id[pid]['version'] != version:
                    raise ValueError(f'review mapping is stale for public_id {pid}')
    if set(aliases) != {row['version'] for row in sets}:
        raise ValueError('version-set metadata is incomplete')
    (out / 'candidates-before.json').write_text(json.dumps(cards, indent=2))
    (out / 'version-sets-before.json').write_text(json.dumps(sets, indent=2))
    redirects = {old: new for old, new in aliases.items() if old != new}
    plan = {'review_sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'aliases': aliases,
            'old_version_count': len(aliases), 'new_version_count': len(set(aliases.values())),
            'affected_cards': len(cards), 'updated_cards': sum(row['version'] in redirects for row in cards)}
    (out / 'plan.json').write_text(json.dumps(plan, indent=2))
    values = ','.join(f"('{old}','{new}')" for old, new in redirects.items())
    expected = ','.join(f"({row['card_id']},'{row['version']}')" for row in cards)
    roots = ','.join("'" + group + "'" for group in sorted(set(aliases.values())))
    migration = f"""BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtext('pokoin-reviewed-artwork-20261012'));
CREATE TEMP TABLE expected(card_id bigint PRIMARY KEY, version text) ON COMMIT DROP;
INSERT INTO expected VALUES {expected};
CREATE TEMP TABLE old_gameplay_names AS SELECT DISTINCT gameplay_name FROM pokoin_version_sets WHERE version IN ({versions});
CREATE TEMP TABLE redirects(old_version text PRIMARY KEY,new_version text) ON COMMIT DROP;
INSERT INTO redirects VALUES {values};
SELECT c.card_id FROM marketplace_search_candidates c JOIN expected e USING(card_id) FOR UPDATE OF c;
CREATE TEMP TABLE preserved_artists AS SELECT c.card_id,c.artist,c.illustrator FROM marketplace_search_candidates c JOIN expected e USING(card_id);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM expected e LEFT JOIN marketplace_search_candidates c USING(card_id) WHERE c.version IS DISTINCT FROM e.version)
 OR (SELECT count(*) FROM marketplace_search_candidates WHERE version IN ({versions})) <> {len(cards)}
 THEN RAISE EXCEPTION 'reviewed membership changed since backup'; END IF;
END $$;
UPDATE marketplace_search_candidates c SET version=r.new_version,projected_at=now()
FROM redirects r WHERE c.version=r.old_version;
UPDATE pokoin_version_sets s SET member_count=(SELECT count(*) FROM marketplace_search_candidates c WHERE c.version=s.version),
 source='artbox-pin-visual-review-20261012',updated_at=now() WHERE s.version IN ({roots});
DELETE FROM pokoin_version_sets s USING redirects r WHERE s.version=r.old_version
 AND NOT EXISTS(SELECT 1 FROM marketplace_search_candidates c WHERE c.version=s.version);
SELECT marketplace_refresh_artwork_cluster_sort(ARRAY[{roots}]::text[]);
UPDATE marketplace_search_candidates c SET artist=p.artist,illustrator=p.illustrator FROM preserved_artists p
WHERE c.card_id=p.card_id AND (c.artist IS DISTINCT FROM p.artist OR c.illustrator IS DISTINCT FROM p.illustrator);
UPDATE pokoin_card_version_groups g SET version_count=(SELECT count(*) FROM pokoin_version_sets s WHERE s.gameplay_name=g.gameplay_name),updated_at=now()
 WHERE g.gameplay_name IN (SELECT gameplay_name FROM old_gameplay_names);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM expected e JOIN marketplace_search_candidates c USING(card_id)
 LEFT JOIN redirects r ON r.old_version=e.version WHERE c.version <> coalesce(r.new_version,e.version))
 THEN RAISE EXCEPTION 'version update verification failed'; END IF;
END $$;
COMMIT;
"""
    (out / 'apply.sql').write_text(migration)
    restore_values = ','.join(f"({row['card_id']},'{row['version']}',{row['artwork_cluster_sort'] if row['artwork_cluster_sort'] is not None else 'NULL'},{row['pokedex_sort'] if row['pokedex_sort'] is not None else 'NULL'})" for row in cards)
    set_json = json.dumps(sets).replace("'", "''")
    rollback = f"""BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtext('pokoin-reviewed-artwork-20261012'));
CREATE TEMP TABLE restore(card_id bigint PRIMARY KEY,version text,artwork_cluster_sort integer,pokedex_sort bigint) ON COMMIT DROP;
INSERT INTO restore VALUES {restore_values};
CREATE TEMP TABLE expected_new(card_id bigint PRIMARY KEY,version text) ON COMMIT DROP;
INSERT INTO expected_new VALUES {','.join(f"({row['card_id']},'{aliases[row['version']]}')" for row in cards)};
SELECT c.card_id FROM marketplace_search_candidates c JOIN expected_new e USING(card_id) FOR UPDATE OF c;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM expected_new e LEFT JOIN marketplace_search_candidates c USING(card_id) WHERE c.version IS DISTINCT FROM e.version)
 OR (SELECT count(*) FROM marketplace_search_candidates WHERE version IN ({versions})) <> {len(cards)}
 THEN RAISE EXCEPTION 'refusing rollback after independent membership changes'; END IF;
END $$;
INSERT INTO pokoin_version_sets SELECT * FROM json_populate_recordset(NULL::pokoin_version_sets,'{set_json}'::json)
ON CONFLICT(version) DO UPDATE SET gameplay_name=excluded.gameplay_name,member_count=excluded.member_count,source=excluded.source,updated_at=excluded.updated_at,art_layout=excluded.art_layout,art_layout_source=excluded.art_layout_source;
UPDATE marketplace_search_candidates c SET version=r.version,artwork_cluster_sort=r.artwork_cluster_sort,pokedex_sort=r.pokedex_sort,projected_at=now() FROM restore r WHERE c.card_id=r.card_id;
UPDATE pokoin_card_version_groups g SET version_count=(SELECT count(*) FROM pokoin_version_sets s WHERE s.gameplay_name=g.gameplay_name),updated_at=now()
WHERE g.gameplay_name IN(SELECT gameplay_name FROM json_populate_recordset(NULL::pokoin_version_sets,'{set_json}'::json));
COMMIT;
"""
    (out / 'rollback.sql').write_text(rollback)
    print(json.dumps({key:value for key,value in plan.items() if key != 'aliases'}))
    if args.apply:
        output = sql(migration)
        (out / 'apply.log').write_text(output)
        after = [json.loads(line) for line in sql(f"SELECT row_to_json(c) FROM marketplace_search_candidates c JOIN (VALUES {','.join('('+str(row['card_id'])+')' for row in cards)}) ids(card_id) USING(card_id) ORDER BY c.card_id;").splitlines()]
        (out / 'candidates-after.json').write_text(json.dumps(after, indent=2))
        print(json.dumps({'applied': True, 'cards': len(after)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--review', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--apply', action='store_true')
    main(parser.parse_args())
