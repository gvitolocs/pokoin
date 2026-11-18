-- Reverse-holo pattern siblings are one painting: join their version sets.
--
-- CardTrader lists each reverse pattern as its own blueprint: Black Bolt
-- 049/086 has "Poké Ball Reverse Holo | 049/086" and "Master Ball Reverse
-- Holo | 049/086" in the "Black Bolt - … Reverse Holo" expansions, CSV9C has
-- "CSV9C | Poké Ball Reverse | 002/208" in "CSV9: Poké Ball Reverse", and a
-- Gem Pack slot has six reverse holos "Energy / Poké Ball / Sparkle / Ripple /
-- Master Ball / Stamped Reverse Holo | 09-01..06/07" (09-07/07 is the IR/SIR,
-- a different painting). The foil overlay drops CLIP below its join
-- thresholds, so the 2026-09-18 pass left 172 such cards (507 printings) and
-- 20 Gem Pack slots split across several version keys.
--
-- Same name + same set family + same printed n/m (or same Gem Pack slot
-- 01..06) with a reverse label is the same card, whatever the scan shows.
-- This joins whole version sets (union-find over the keys), so the CLIP
-- reprints already attached to either side come along. Root key: pinned
-- sources first, then the larger set. A key or chain that would add a
-- second illustrator is skipped (CardTrader sometimes ships another card's
-- scan under a blueprint, and CLIP then filed it with that other card).
--
-- Run after every CLIP version match (scripts/match-imported-version-sets.sh,
-- scripts/ingest-missing-product-images.py), because a CLIP re-cluster of a
-- name bucket resets these printings first:
--   SELECT * FROM public.marketplace_join_reverse_pattern_versions();      -- plan
--   SELECT * FROM public.marketplace_join_reverse_pattern_versions(true);  -- apply

CREATE OR REPLACE FUNCTION public.marketplace_join_reverse_pattern_versions(p_apply boolean DEFAULT false)
RETURNS TABLE (root_version text, merged_versions text[], moved_rows integer, gameplay_name text)
LANGUAGE plpgsql
SET search_path TO 'public'
SET client_min_messages TO warning
AS $function$
DECLARE
  changed integer;
  roots text[];
BEGIN
  DROP TABLE IF EXISTS pg_temp._rp_rows;
  CREATE TEMP TABLE _rp_rows ON COMMIT DROP AS
  WITH keyed AS (
    SELECT c.card_id,
           c.version,
           c.card_number ~* 'reverse' AS is_reverse,
           CASE
             WHEN c.set_name ~ '^Gem Pack'
               THEN CASE
                 WHEN c.card_number ~* 'reverse[^|]*\|\s*\d+-0[1-6]/07\s*$'
                   THEN 'gem|' || c.set_name || '|' || lower(c.name) || '|'
                        || substring(c.card_number from '(\d+)-0[1-6]/07\s*$')::int
               END
             WHEN c.card_number ~ '[A-Za-z]*\d+/[A-Za-z]*\d+\s*$'
               THEN 'num|' || lower(split_part(split_part(c.set_name, ' - ', 1), ':', 1))
                    || '|' || lower(c.name) || '|'
                    || regexp_replace(
                         lower(substring(c.card_number from '([A-Za-z]*\d+/[A-Za-z]*\d+)\s*$')),
                         '(^|/|[a-z])0+(\d)', '\1\2', 'g')
           END AS sib_key
      FROM marketplace_search_candidates c
     WHERE c.item_kind = 'single'
       AND c.product_type = 'card'
       AND coalesce(c.version, '') <> ''
  ),
  split_keys AS (
    SELECT sib_key
      FROM keyed
     WHERE sib_key IS NOT NULL
     GROUP BY sib_key
    HAVING bool_or(is_reverse) AND count(DISTINCT version) > 1
  ),
  key_artists AS (
    SELECT kv.sib_key, kv.version, c.artist
      FROM (SELECT DISTINCT k.sib_key, k.version FROM keyed k JOIN split_keys USING (sib_key)) kv
      JOIN marketplace_search_candidates c ON c.version = kv.version
     WHERE coalesce(c.artist, '') <> ''
  ),
  -- A second illustrator is a second painting (D000095). Skip a key whose
  -- join would bring one in: CardTrader shifted the CSV10C Master Ball
  -- Reverse scans (172/222 Porygon shows Porygon2 173), so CLIP filed it
  -- with the Porygon2 set and the number would glue the two.
  safe_keys AS (
    SELECT s.sib_key
      FROM split_keys s
     WHERE (SELECT count(DISTINCT a.artist) FROM key_artists a WHERE a.sib_key = s.sib_key)
        <= coalesce((
             SELECT max(n)
               FROM (SELECT count(DISTINCT a.artist) AS n
                       FROM key_artists a
                      WHERE a.sib_key = s.sib_key
                      GROUP BY a.version) per_version
           ), 0)
  )
  SELECT k.card_id, k.version, k.sib_key
    FROM keyed k
    JOIN safe_keys USING (sib_key);

  DROP TABLE IF EXISTS pg_temp._rp_comp;
  CREATE TEMP TABLE _rp_comp ON COMMIT DROP AS
  SELECT v.version,
         row_number() OVER (
           ORDER BY CASE
                      WHEN s.source = 'storm-emeralda-printings' THEN 0
                      WHEN s.source LIKE '%artbox-pin%' THEN 1
                      WHEN s.source = 'singleton' THEN 3
                      ELSE 2
                    END,
                    m.members DESC,
                    v.version
         )::integer AS rank,
         0 AS comp
    FROM (SELECT DISTINCT version FROM _rp_rows) v
    LEFT JOIN pokoin_version_sets s ON s.version = v.version
    JOIN LATERAL (
      SELECT count(*) AS members
        FROM marketplace_search_candidates c
       WHERE c.version = v.version
    ) m ON true;
  UPDATE _rp_comp SET comp = rank;

  LOOP
    UPDATE _rp_comp t
       SET comp = m.low
      FROM (
        SELECT r.version, min(c2.comp) AS low
          FROM _rp_rows r
          JOIN _rp_rows r2 ON r2.sib_key = r.sib_key
          JOIN _rp_comp c2 ON c2.version = r2.version
         GROUP BY r.version
      ) m
     WHERE m.version = t.version
       AND m.low < t.comp;
    GET DIAGNOSTICS changed = ROW_COUNT;
    EXIT WHEN changed = 0;
  END LOOP;

  -- Same guard for whole components: keys chained through other keys must
  -- not end with more illustrators than any one of the joined sets had.
  DELETE FROM _rp_comp t
   USING (
     SELECT x.comp
       FROM (
         SELECT rc.comp, rc.version, c.artist
           FROM _rp_comp rc
           JOIN marketplace_search_candidates c ON c.version = rc.version
          WHERE coalesce(c.artist, '') <> ''
       ) x
      GROUP BY x.comp
     HAVING count(DISTINCT x.artist) > (
       SELECT max(n)
         FROM (SELECT count(DISTINCT c.artist) AS n
                 FROM _rp_comp rc
                 JOIN marketplace_search_candidates c ON c.version = rc.version
                WHERE rc.comp = x.comp
                  AND coalesce(c.artist, '') <> ''
                GROUP BY rc.version) per_version
     )
   ) bad
   WHERE t.comp = bad.comp;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed > 0 THEN
    RAISE WARNING 'reverse-pattern join skipped % version keys in mixed-illustrator components', changed;
  END IF;

  DROP TABLE IF EXISTS pg_temp._rp_plan;
  CREATE TEMP TABLE _rp_plan ON COMMIT DROP AS
  SELECT r.version AS root,
         c.version AS merged,
         (SELECT count(*)::integer
            FROM marketplace_search_candidates mc
           WHERE mc.version = c.version) AS moved
    FROM _rp_comp c
    JOIN _rp_comp r ON r.rank = c.comp
   WHERE c.version <> r.version;

  IF p_apply THEN
    UPDATE marketplace_search_candidates c
       SET version = p.root
      FROM _rp_plan p
     WHERE c.version = p.merged;

    SELECT array_agg(DISTINCT root) INTO roots FROM _rp_plan;

    UPDATE pokoin_version_sets s
       SET member_count = m.members,
           source = CASE WHEN s.source = 'singleton' THEN 'reverse-pattern' ELSE s.source END,
           updated_at = now()
      FROM (
        SELECT c.version, count(*)::integer AS members
          FROM marketplace_search_candidates c
         WHERE c.version = ANY (roots)
         GROUP BY c.version
      ) m
     WHERE s.version = m.version;

    DELETE FROM pokoin_version_sets s
     USING _rp_plan p
     WHERE s.version = p.merged
       AND NOT EXISTS (
         SELECT 1 FROM marketplace_search_candidates c WHERE c.version = s.version
       );

    IF roots IS NOT NULL THEN
      PERFORM marketplace_refresh_artwork_cluster_sort(roots);
    END IF;
  END IF;

  RETURN QUERY
  SELECT p.root,
         array_agg(p.merged ORDER BY p.merged),
         sum(p.moved)::integer,
         max(s.gameplay_name)
    FROM _rp_plan p
    LEFT JOIN pokoin_version_sets s ON s.version = p.root
   GROUP BY p.root
   ORDER BY p.root;
END;
$function$;
