
      with target as (
        select *
        from public.marketplace_card_versions
        where card_id = $1
        limit 1
      ), ranked as (
        select
          versions.card_id,
          versions.name,
          versions.expansion_name,
          versions.expansion_number,
          versions.expansion_number_int,
          versions.product_variant,
          case
            when count(*) over (partition by versions.expansion_name, versions.name) > 1
              then concat(
                'v',
                row_number() over (
                  partition by versions.expansion_name, versions.name
                  order by versions.expansion_number_int nulls last, versions.expansion_number, versions.card_id
                )
              )
            else ''
          end as inferred_product_variant,
          versions.product_type
        from public.marketplace_card_versions versions
        join target
          on target.expansion_name = versions.expansion_name
         and target.name = versions.name
        where versions.product_type in ('card', 'jumbo')
      )
      select
        ranked.card_id,
        ranked.name,
        ranked.expansion_name,
        ranked.expansion_number,
        ranked.product_variant,
        ranked.inferred_product_variant,
        ranked.product_type,
        coalesce(expansion_rules.cardmarket_expansion_slug, '') as cardmarket_expansion_slug,
        coalesce(expansion_rules.cardmarket_set_code, '') as cardmarket_set_code,
        coalesce(expansion_rules.cardmarket_context_code, '') as cardmarket_context_code,
        coalesce(expansion_rules.number_format_rule, '') as number_format_rule,
        expansions.code as expansion_code,
        cards.card_type
      from ranked
      left join public.pokoin_pokemon_expansions expansions
        on expansions.name = ranked.expansion_name
      left join public.marketplace_cards cards
        on cards.card_id = ranked.card_id
      left join lateral (
        select
          cardmarket_expansion_slug,
          cardmarket_set_code,
          cardmarket_context_code,
          number_format_rule
        from public.marketplace_cm_expansion_rules rules
        where rules.expansion_name = ranked.expansion_name
          and rules.cardmarket_locale = 'en'
          and rules.confidence in ('verified', 'manual')
        order by
          case
            when rules.applies_to_card_type = coalesce(cards.card_type, '') then 0
            when rules.applies_to_card_type = '' then 1
            else 2
          end,
          rules.verified_at desc nulls last,
          rules.updated_at desc
        limit 1
      ) expansion_rules on true
      where ranked.card_id = $1
      limit 1
    