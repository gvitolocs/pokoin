-- Lazy CardTrader language + 11 Sep complete-book cutover.
--
-- 1. Empty pokemon_language is not English. Sellers skip the field; we had
--    coalesced it to EN. Default is the expansion print language. Explicit
--    pokemon_language=en on a JP/CN card stays EN.
-- 2. 11 Sep inferred_sale is the first complete-book persist vs the stale Pi
--    clone (~131k listings / 576k copies). Not that day's market. Keep
--    quantity_decreased (2,591 listings / 3,976 copies). History rows stay.

begin;
set local statement_timeout = 0;
set local lock_timeout = 0;
set local idle_in_transaction_session_timeout = 0;

create or replace function public.cardtrader_default_language_for_nationality(nationality text)
returns text
language sql
immutable
parallel safe
as $$
  select case lower(btrim(coalesce(nationality, '')))
    when 'japanese' then 'JP'
    when 'korean' then 'KO'
    when 'chinese' then 'ZH'
    when 'indonesian' then 'ID'
    when 'idth' then 'ID'
    when 'thai' then 'TH'
    when 'french' then 'FR'
    when 'german' then 'DE'
    else 'EN'
  end;
$$;

create or replace function public.cardtrader_listing_language(
  stored_language text,
  properties jsonb default '{}'::jsonb,
  nationality text default ''
)
returns text
language sql
immutable
parallel safe
as $$
  select coalesce(
    public.cardtrader_sold_language(nullif(btrim(coalesce(properties->>'pokemon_language', '')), '')),
    case
      when public.cardtrader_sold_language(stored_language) is not null
        and public.cardtrader_sold_language(stored_language) is distinct from 'EN'
        then public.cardtrader_sold_language(stored_language)
      else public.cardtrader_default_language_for_nationality(nationality)
    end
  );
$$;

create or replace function public.cardtrader_listing_language_for_blueprint(
  stored_language text,
  properties jsonb,
  p_blueprint_id bigint
)
returns text
language sql
stable
as $$
  select public.cardtrader_listing_language(
    stored_language,
    coalesce(properties, '{}'::jsonb),
    (
      select e.nationality
      from public.pokoin_pokemon_blueprints b
      join public.pokoin_pokemon_expansions e on e.expansion_id = b.expansion_id
      where b.id = p_blueprint_id
      limit 1
    )
  );
$$;

update public.cardtrader_market_listing_snapshots snapshot
set language = public.cardtrader_listing_language(
  snapshot.language,
  coalesce(snapshot.properties, '{}'::jsonb),
  e.nationality
)
from public.pokoin_pokemon_blueprints b
join public.pokoin_pokemon_expansions e on e.expansion_id = b.expansion_id
where b.id = coalesce(snapshot.blueprint_id, snapshot.cardtrader_blueprint_id)
  and (
    coalesce(nullif(btrim(snapshot.language), ''), '') = ''
    or (
      public.cardtrader_sold_language(snapshot.language) = 'EN'
      and coalesce(nullif(btrim(snapshot.properties->>'pokemon_language'), ''), '') = ''
      and e.nationality in ('japanese', 'korean', 'chinese', 'indonesian', 'thai', 'idth', 'french', 'german')
    )
  );

update public.cardtrader_market_listing_removed_history history
set language = public.cardtrader_listing_language(
  history.language,
  coalesce(history.properties, '{}'::jsonb),
  e.nationality
)
from public.pokoin_pokemon_blueprints b
join public.pokoin_pokemon_expansions e on e.expansion_id = b.expansion_id
where b.id = coalesce(history.blueprint_id, history.cardtrader_blueprint_id)
  and (
    coalesce(nullif(btrim(history.language), ''), '') = ''
    or (
      public.cardtrader_sold_language(history.language) = 'EN'
      and coalesce(nullif(btrim(history.properties->>'pokemon_language'), ''), '') = ''
      and e.nationality in ('japanese', 'korean', 'chinese', 'indonesian', 'thai', 'idth', 'french', 'german')
    )
  );

update public.marketplace_price_observations obs
set language = public.cardtrader_listing_language(
  obs.language,
  coalesce(history.properties, '{}'::jsonb),
  e.nationality
)
from public.cardtrader_market_listing_removed_history history
join public.pokoin_pokemon_blueprints b
  on b.id = coalesce(history.blueprint_id, history.cardtrader_blueprint_id)
join public.pokoin_pokemon_expansions e on e.expansion_id = b.expansion_id
where obs.source = 'cardtrader_removed_sale'
  and obs.source_item_id like 'cardtrader:%'
  and history.provider || ':' || history.external_listing_id || ':'
    || history.removed_day::text || ':' || history.archive_reason = obs.source_item_id
  and (
    coalesce(nullif(btrim(obs.language), ''), '') = ''
    or (
      public.cardtrader_sold_language(obs.language) = 'EN'
      and coalesce(nullif(btrim(history.properties->>'pokemon_language'), ''), '') = ''
      and e.nationality in ('japanese', 'korean', 'chinese', 'indonesian', 'thai', 'idth', 'french', 'german')
    )
  );

delete from public.marketplace_price_observations
where source = 'cardtrader_removed_sale'
  and source_item_id like 'cardtrader:%:2026-09-11:inferred_sale';

create or replace function public.refresh_cardtrader_sold_daily(
  target_day date default null
)
returns integer
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
as $$
declare
  refreshed_count integer := 0;
begin
  perform set_config('statement_timeout', '0', true);

  if target_day is not null then
    delete from public.cardtrader_sold_daily
    where observed_day = target_day;
  else
    truncate public.cardtrader_sold_daily;
  end if;

  insert into public.cardtrader_sold_daily (
    blueprint_id,
    observed_day,
    condition,
    language,
    reverse,
    first_edition,
    graded,
    median_pkn,
    min_pkn,
    max_pkn,
    sold_qty,
    listings,
    sample_count,
    graded_comments,
    refreshed_at
  )
  select
    obs.blueprint_id,
    (obs.observed_at at time zone 'utc')::date as observed_day,
    public.cardtrader_sold_condition(obs.condition) as condition,
    public.cardtrader_sold_language(obs.language) as language,
    public.cardtrader_listing_is_reverse(
      coalesce(history.properties, '{}'::jsonb),
      obs.reverse,
      obs.foil_state
    ) as reverse,
    public.cardtrader_listing_is_first_edition(
      coalesce(history.properties, '{}'::jsonb),
      obs.first_edition
    ) as first_edition,
    obs.graded,
    percentile_cont(0.5) within group (order by obs.price_pkn) as median_pkn,
    min(obs.price_pkn) as min_pkn,
    max(obs.price_pkn) as max_pkn,
    coalesce(sum(obs.quantity), 0)::integer as sold_qty,
    count(*)::integer as listings,
    count(*)::integer as sample_count,
    case
      when obs.graded then coalesce(
        array_remove(array_agg(distinct nullif(obs.metadata->>'sellerComment', '')), null),
        '{}'::text[]
      )
      else '{}'::text[]
    end as graded_comments,
    now()
  from public.marketplace_price_observations obs
  left join public.cardtrader_market_listing_removed_history history
    on history.provider || ':' || history.external_listing_id || ':' || history.removed_day::text || ':' || history.archive_reason
      = obs.source_item_id
  left join (
    select split_part(source_item_id, ':', 2) as listing_id
    from public.marketplace_price_observations
    where source = 'cardtrader_removed_sale'
      and source_item_id like 'cardtrader:%'
      and split_part(source_item_id, ':', 4) is distinct from 'quantity_decreased'
    group by 1
    having count(distinct (observed_at at time zone 'utc')::date) = 1
  ) once_sold
    on once_sold.listing_id = split_part(obs.source_item_id, ':', 2)
  where obs.source = 'cardtrader_removed_sale'
    and obs.source_item_id like 'cardtrader:%'
    and split_part(obs.source_item_id, ':', 4) in ('inferred_sale', 'quantity_decreased')
    and not (
      (obs.observed_at at time zone 'utc')::date = date '2026-09-11'
      and split_part(obs.source_item_id, ':', 4) = 'inferred_sale'
    )
    and obs.price_pkn > 0
    and obs.blueprint_id is not null
    and (target_day is null or (obs.observed_at at time zone 'utc')::date = target_day)
    and public.cardtrader_sold_condition(obs.condition) is not null
    and public.cardtrader_sold_language(obs.language) is not null
    and (
      split_part(obs.source_item_id, ':', 4) = 'quantity_decreased'
      or once_sold.listing_id is not null
    )
  group by
    obs.blueprint_id,
    (obs.observed_at at time zone 'utc')::date,
    public.cardtrader_sold_condition(obs.condition),
    public.cardtrader_sold_language(obs.language),
    public.cardtrader_listing_is_reverse(
      coalesce(history.properties, '{}'::jsonb),
      obs.reverse,
      obs.foil_state
    ),
    public.cardtrader_listing_is_first_edition(
      coalesce(history.properties, '{}'::jsonb),
      obs.first_edition
    ),
    obs.graded;

  get diagnostics refreshed_count = row_count;
  return coalesce(refreshed_count, 0);
end;
$$;

select public.refresh_cardtrader_sold_daily() as sold_daily_rows;
select public.refresh_marketplace_blueprint_price_summary(null) as price_summary_rows;

commit;
