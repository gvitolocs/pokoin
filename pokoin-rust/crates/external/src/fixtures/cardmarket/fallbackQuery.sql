
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
        '' as cardmarket_expansion_slug,
        '' as cardmarket_set_code,
        '' as cardmarket_context_code,
        '' as number_format_rule,
        expansions.code as expansion_code,
        cards.card_type
      from ranked
      left join public.pokoin_pokemon_expansions expansions
        on expansions.name = ranked.expansion_name
      left join public.marketplace_cards cards
        on cards.card_id = ranked.card_id
      where ranked.card_id = $1
      limit 1
    