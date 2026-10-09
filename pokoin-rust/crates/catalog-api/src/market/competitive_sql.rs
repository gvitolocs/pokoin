//! Verbatim SQL of `marketplace-competitive.js` (generated from the reference handler).

/// marketplace-competitive.js:450
pub const SQL_0: &str = r#"
      select game_id, name, formats, platforms, metagame
      from public.limitless_games
      order by
        case when game_id = 'PTCG' then 0 when game_id = 'POCKET' then 1 else 2 end,
        name asc
    "#;

/// marketplace-competitive.js:471
pub const SQL_1: &str = r#"
      select
        t.tournament_id,
        t.name,
        t.game_id,
        g.name as game_name,
        t.format,
        coalesce(g.formats ->> t.format, t.format, '') as format_label,
        t.tournament_date,
        t.player_count,
        t.organizer_id,
        t.organizer_name,
        t.platform,
        t.decklists_available,
        t.is_public,
        t.is_online,
        t.phases,
        t.source_url,
        t.details_fetched_at,
        t.standings_fetched_at,
        t.pairings_fetched_at,
        t.updated_at
      from public.limitless_tournaments t
      left join public.limitless_games g on g.game_id = t.game_id
      ${where}
      order by t.tournament_date desc nulls last, t.player_count desc, t.tournament_id desc
      limit $${values.length}
    "#;

/// marketplace-competitive.js:520
pub const SQL_2: &str = r#"
      with filtered as (
        select
          coalesce(nullif(s.deck_archetype, ''), nullif(s.deck_name, ''), 'Unknown deck') as archetype,
          t.game_id,
          t.format,
          coalesce(g.formats ->> t.format, t.format, '') as format_label,
          s.display_name,
          s."placing",
          s.wins,
          s.losses,
          s.ties,
          s.decklist_id,
          t.tournament_id,
          t.name as tournament_name,
          t.tournament_date
        from public.limitless_tournament_standings s
        join public.limitless_tournaments t on t.tournament_id = s.tournament_id
        left join public.limitless_games g on g.game_id = t.game_id
        ${where}
      ),
      ranked as (
        select
          *,
          row_number() over (
            partition by archetype
            order by "placing" asc nulls last, wins desc, losses asc, tournament_date desc nulls last
          ) as featured_rank
        from filtered
      ),
      grouped as (
        select
          archetype,
          max(game_id) as game_id,
          max(format) as format,
          max(format_label) as format_label,
          count(*)::integer as deck_count,
          case
            when sum(count(*)) over () = 0 then 0
            else round((count(*)::numeric / sum(count(*)) over ()) * 100, 1)
          end as share
        from filtered
        group by archetype
      ),
      top_grouped as (
        select *
        from grouped
        order by deck_count desc, archetype asc
        limit $${values.length}
      )
      select
        top_grouped.*,
        ranked.display_name as featured_player,
        ranked."placing" as featured_placing,
        ranked.wins as featured_wins,
        ranked.losses as featured_losses,
        ranked.ties as featured_ties,
        ranked.decklist_id as featured_decklist_id,
        ranked.tournament_id as featured_tournament_id,
        ranked.tournament_name as featured_tournament_name,
        ranked.tournament_date as featured_tournament_date,
        representative.card_id as representative_card_id,
        representative.name as representative_card_name,
        representative.set_name as representative_card_set_name,
        representative.card_number as representative_card_number,
        representative.canonical_path as representative_card_path,
        representative.image_url as representative_image_url
      from top_grouped
      left join ranked on ranked.archetype = top_grouped.archetype and ranked.featured_rank = 1
      left join lateral (
        select
          c.card_id,
          c.name,
          c.set_name,
          c.card_number,
          coalesce(urls.canonical_path, '') as canonical_path,
          coalesce(
            nullif(c.preview_image_url, ''),
            nullif(c.homepage_image_url, ''),
            nullif(c.cdn_image_url, ''),
            nullif(c.image_url, ''),
            ''
          ) as image_url
        from public.marketplace_search_candidates c
        left join public.marketplace_card_urls urls
          on urls.card_id = c.card_id and urls.language = 'en'
        cross join lateral (
          select
            regexp_replace(lower(top_grouped.archetype), '[^a-z0-9]+', '', 'g') as compact_archetype,
            regexp_replace(lower(top_grouped.archetype), '[^a-z0-9]+', ' ', 'g') as archetype_words,
            regexp_replace(lower(coalesce(nullif(c.canonical_name, ''), c.name)), '[^a-z0-9]+', '', 'g') as compact_card,
            regexp_replace(lower(coalesce(nullif(c.canonical_name, ''), c.name)), '[^a-z0-9]+', ' ', 'g') as card_words
        ) normalized
        cross join lateral (
          select array_remove(array_agg(token.value), null) as tokens
          from regexp_split_to_table(normalized.archetype_words, '[[:space:]]+') as token(value)
          where length(token.value) >= 4
            and token.value not in (
              'mega', 'pokemon', 'pokémon', 'deck', 'box', 'toolbox', 'lost',
              'zone', 'future', 'ancient', 'control', 'stall', 'turbo',
              'festival', 'lead', 'ex', 'vstar', 'vmax', 'basic'
            )
        ) significant
        where c.item_kind = 'single'
          and coalesce(c.preview_image_url, c.homepage_image_url, c.cdn_image_url, c.image_url, '') <> ''
          and normalized.compact_archetype <> ''
          and (
            normalized.compact_card = normalized.compact_archetype
            or normalized.compact_card like normalized.compact_archetype || '%'
            or normalized.compact_archetype like normalized.compact_card || '%'
            or (coalesce(array_length(significant.tokens, 1), 0) > 0 and exists (
              select 1
              from unnest(significant.tokens) as token(value)
              where normalized.card_words like '%' || token.value || '%'
            ))
          )
        order by
          case when normalized.compact_card = normalized.compact_archetype then 0 else 1 end,
          case when normalized.compact_card like normalized.compact_archetype || '%' then 0 else 1 end,
          case when normalized.compact_archetype like normalized.compact_card || '%' then 0 else 1 end,
          (
            select count(*)
            from unnest(significant.tokens) as token(value)
            where normalized.card_words like '%' || token.value || '%'
          ) desc,
          c.search_weight desc,
          c.imported_at desc nulls last,
          c.card_id asc
        limit 1
      ) representative on true
      order by top_grouped.deck_count desc, top_grouped.archetype asc
    "#;

/// marketplace-competitive.js:683
pub const SQL_3: &str = r#"
      with top_decks as (
        select
          d.deck_id,
          d.name as archetype,
          'PTCG' as game_id,
          coalesce(d.format, '') as format,
          coalesce(d.format_label, d.format, '') as format_label,
          d.points as deck_count,
          d.points,
          d.share,
          d.source_url
        from public.limitless_public_decks d
        ${where}
        order by d.rank asc nulls last, d.points desc, d.share desc, d.name asc
        limit $${values.length}
      )
      select
        d.*,
        featured.player_name as featured_player,
        featured."placing" as featured_placing,
        featured.decklist_id as featured_decklist_id,
        featured.tournament_id as featured_tournament_id,
        featured.tournament_name as featured_tournament_name,
        featured.tournament_date as featured_tournament_date,
        null::bigint as representative_card_id,
        ''::text as representative_card_name,
        ''::text as representative_card_set_name,
        ''::text as representative_card_number,
        ''::text as representative_card_path,
        ''::text as representative_image_url
      from top_decks d
      left join lateral (
        select *
        from public.limitless_public_deck_results r
        where r.deck_id = d.deck_id
        order by r.tournament_date desc nulls last, r."placing" asc nulls last, r.player_name asc
        limit 1
      ) featured on true
      order by d.deck_count desc, d.archetype asc
    "#;

/// marketplace-competitive.js:757
pub const SQL_4: &str = r#"
      select
        t.tournament_id,
        t.name,
        t.game_id,
        g.name as game_name,
        t.format,
        coalesce(g.formats ->> t.format, t.format, '') as format_label,
        t.tournament_date,
        t.player_count,
        t.organizer_id,
        t.organizer_name,
        t.platform,
        t.decklists_available,
        t.is_public,
        t.is_online,
        t.phases,
        t.source_url,
        t.details_fetched_at,
        t.standings_fetched_at,
        t.pairings_fetched_at,
        t.updated_at
      from public.limitless_tournaments t
      left join public.limitless_games g on g.game_id = t.game_id
      ${where}
      ${groupFilter}
      order by ${orderBy}
      limit $${values.length}
    "#;

/// marketplace-competitive.js:813
pub const SQL_5: &str = r#"
      select *
      from public.limitless_public_tournaments t
      ${where}
      order by t.tournament_date desc nulls last, t.player_count desc, t.tournament_id desc
      limit $${values.length}
    "#;

/// marketplace-competitive.js:843
pub const SQL_6: &str = r#"
      select distinct extract(year from t.tournament_date)::integer as year
      from public.limitless_tournaments t
      ${where}
        and t.tournament_date is not null
      order by year desc
      limit 12
    "#;

/// marketplace-competitive.js:865
pub const SQL_7: &str = r#"
      select
        t.tournament_id,
        t.name,
        t.game_id,
        g.name as game_name,
        t.format,
        coalesce(g.formats ->> t.format, t.format, '') as format_label,
        t.tournament_date,
        t.player_count,
        t.organizer_id,
        t.organizer_name,
        t.platform,
        t.decklists_available,
        t.is_public,
        t.is_online,
        t.phases,
        t.source_url,
        t.details_fetched_at,
        t.standings_fetched_at,
        t.pairings_fetched_at,
        t.updated_at
      from public.limitless_tournaments t
      left join public.limitless_games g on g.game_id = t.game_id
      where t.tournament_id = $1
      limit 1
    "#;

/// marketplace-competitive.js:898
pub const SQL_8: &str = r#"
      select *
      from public.limitless_tournament_standings
      where tournament_id = $1
      order by "placing" asc nulls last, wins desc, losses asc, display_name asc
      limit $2
    "#;

/// marketplace-competitive.js:909
pub const SQL_9: &str = r#"
      select
        p.phase,
        p.round,
        p.table_number,
        p.player1_id,
        coalesce(player1.display_name, p.player1_id) as player1_name,
        p.player2_id,
        coalesce(player2.display_name, p.player2_id) as player2_name,
        p.winner_player_id,
        p.result
      from public.limitless_tournament_pairings p
      left join public.limitless_players player1 on player1.player_id = p.player1_id
      left join public.limitless_players player2 on player2.player_id = p.player2_id
      where p.tournament_id = $1
      order by p.phase desc, p.round desc, p.table_number asc, p.match_index asc
      limit $2
    "#;

/// marketplace-competitive.js:945
pub const SQL_10: &str = r#"
      select *
      from public.limitless_public_tournaments
      where tournament_id = $1
      limit 1
    "#;

/// marketplace-competitive.js:957
pub const SQL_11: &str = r#"
      select *
      from public.limitless_public_tournament_standings
      where tournament_id = $1
      order by "placing" asc nulls last, player_name asc
      limit $2
    "#;

/// marketplace-competitive.js:989
pub const SQL_12: &str = r#"
      select *
      from public.limitless_public_decks
      where deck_id = $1
      limit 1
    "#;

/// marketplace-competitive.js:1001
pub const SQL_13: &str = r#"
      select
        core.*,
        coalesce(mapped_card.card_id, fallback_card.card_id) as marketplace_card_id,
        coalesce(mapped_card.marketplace_card_path, fallback_card.marketplace_card_path, '') as marketplace_card_path,
        coalesce(mapped_card.marketplace_image_url, fallback_card.marketplace_image_url, '') as marketplace_image_url
      from public.limitless_public_deck_core_cards core
      ${JOIN}
      where core.deck_id = $1
      order by core.inclusion_share desc nulls last, core.count desc nulls last, core.display_name asc
      limit $2
    "#;

/// marketplace-competitive.js:1016
pub const SQL_14: &str = r#"
      select *
      from public.limitless_public_deck_results
      where deck_id = $1
      order by tournament_date desc nulls last, "placing" asc nulls last, player_name asc
      limit $2
    "#;

/// marketplace-competitive.js:1026
pub const SQL_15: &str = r#"
      select *
      from public.limitless_public_deck_players
      where deck_id = $1
      order by rank asc nulls last, points desc, player_name asc
      limit $2
    "#;

/// marketplace-competitive.js:1042
pub const SQL_16: &str = r#"
        select
          deck_card.*,
          coalesce(mapped_card.card_id, fallback_card.card_id) as marketplace_card_id,
          coalesce(mapped_card.marketplace_card_path, fallback_card.marketplace_card_path, '') as marketplace_card_path,
          coalesce(mapped_card.marketplace_image_url, fallback_card.marketplace_image_url, '') as marketplace_image_url
        from public.limitless_public_decklist_cards deck_card
        ${JOIN}
        where deck_card.decklist_id = any($1::text[])
        order by deck_card.decklist_id, deck_card.section, deck_card.count desc, deck_card.card_name asc
      "#;

/// marketplace-competitive.js:1093
pub const SQL_17: &str = r#"
      select
        r.decklist_id,
        r.deck_id,
        coalesce(d.name, r.variant, '') as deck_name,
        coalesce(r.format, d.format, '') as format,
        coalesce(d.format_label, r.format, '') as format_label,
        r.tournament_id,
        coalesce(t.name, r.tournament_name, '') as tournament_name,
        coalesce(r.tournament_date, t.tournament_date) as tournament_date,
        r."placing",
        r.placing_label,
        r.variant,
        r.player_id,
        r.player_name,
        coalesce(r.source_url, '') as source_url,
        coalesce(d.source_url, '') as deck_source_url,
        coalesce(t.source_url, '') as tournament_source_url
      from public.limitless_public_deck_results r
      left join public.limitless_public_decks d on d.deck_id = r.deck_id
      left join public.limitless_public_tournaments t on t.tournament_id = r.tournament_id
      where r.decklist_id = $1
      order by r.tournament_date desc nulls last, r."placing" asc nulls last, r.player_name asc
      limit 1
    "#;

/// marketplace-competitive.js:1123
pub const SQL_18: &str = r#"
        select
          s.decklist_id,
          s.deck_id,
          coalesce(s.deck_name, d.name, s.variant, '') as deck_name,
          coalesce(t.format, d.format, '') as format,
          coalesce(t.format_label, d.format_label, t.format, d.format, '') as format_label,
          s.tournament_id,
          coalesce(t.name, '') as tournament_name,
          t.tournament_date,
          s."placing",
          ''::text as placing_label,
          s.variant,
          s.player_id,
          s.player_name,
          coalesce(s.source_url, '') as source_url,
          coalesce(d.source_url, '') as deck_source_url,
          coalesce(t.source_url, '') as tournament_source_url
        from public.limitless_public_tournament_standings s
        left join public.limitless_public_decks d on d.deck_id = s.deck_id
        left join public.limitless_public_tournaments t on t.tournament_id = s.tournament_id
        where s.decklist_id = $1
        order by t.tournament_date desc nulls last, s."placing" asc nulls last, s.player_name asc
        limit 1
      "#;

/// marketplace-competitive.js:1154
pub const SQL_19: &str = r#"
      select
        deck_card.*,
        coalesce(mapped_card.card_id, fallback_card.card_id) as marketplace_card_id,
        coalesce(mapped_card.marketplace_card_path, fallback_card.marketplace_card_path, '') as marketplace_card_path,
        coalesce(mapped_card.marketplace_image_url, fallback_card.marketplace_image_url, '') as marketplace_image_url
      from public.limitless_public_decklist_cards deck_card
      ${JOIN}
      where deck_card.decklist_id = $1
      order by deck_card.section, deck_card.count desc, deck_card.card_name asc
    "#;

/// marketplace-competitive.js:1178
pub const SQL_20: &str = r#"
      select
        count(*)::integer as tournament_count,
        coalesce(sum(player_count), 0)::integer as total_players,
        count(*) filter (where standings_fetched_at is not null)::integer as standings_count,
        count(*) filter (where pairings_fetched_at is not null)::integer as pairings_count,
        max(updated_at) as updated_at
      from public.limitless_tournaments t
      ${where}
    "#;

/// marketplace-competitive.js:1192
pub const SQL_21: &str = r#"
      select
        count(*)::integer as deck_count,
        coalesce(sum(points), 0)::integer as total_points,
        max(updated_at) as updated_at
      from public.limitless_public_decks
    "#;

