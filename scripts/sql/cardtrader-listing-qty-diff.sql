-- Per-listing CardTrader qty diffs for every facet combo
-- (language × condition × reverse × 1st edition × graded).
-- Daily job fetches the full listing book (cheap-25 trim is gone).
-- A stack is seller + blueprint + condition + language + reverse + 1st +
-- graded — not CardTrader product id. Vanished ids while that stack is
-- still listed are listing_id_rotated — including sibling product ids that
-- were already in the book (sellers split one stack across many rows).
-- inferred_sale only when the seller no longer lists that stack. Combined
-- qty drops on a still-listed stack are quantity_decreased (on top of
-- same-id qty drip). Do not require the successor id to be new, and do
-- not require live qty to equal the vanished row. Seller on vacation
-- (cardtrader_seller_vacation / on_vacation on the product) is not a
-- sale — freeze those snapshots. Whole-shop vanish is reclassified at
-- finalize (075_seller_vacation.sql).

begin;

set local statement_timeout = 0;
set local lock_timeout = 0;
set local idle_in_transaction_session_timeout = 0;

create or replace function public.cardtrader_listing_is_first_edition(
  properties jsonb default '{}'::jsonb,
  first_edition boolean default false
)
returns boolean
language sql
immutable
as $$
  select coalesce(first_edition, false)
    or lower(coalesce(
      properties->>'first_edition',
      properties->>'firstEdition',
      properties->>'pokemon_first_edition',
      ''
    )) in ('true', '1', 'yes');
$$;

create or replace function public.cardtrader_listing_is_reverse(
  properties jsonb default '{}'::jsonb,
  reverse boolean default false,
  foil_state text default ''::text
)
returns boolean
language sql
immutable
as $$
  select coalesce(reverse, false)
    or lower(btrim(coalesce(foil_state, ''))) = 'reverse'
    or lower(coalesce(properties->>'foil_state', properties->>'foilState', '')) = 'reverse'
    or lower(coalesce(properties->>'pokemon_reverse', '')) in ('true', '1', 'yes', 'reverse');
$$;

create or replace function public.cardtrader_market_archive_reason(
  incoming_listing_count integer,
  incoming_ceiling_price numeric,
  existing_price numeric
)
returns text
language sql
immutable
as $$
  select case
    when incoming_ceiling_price is null then 'inferred_sale'
    when coalesce(incoming_listing_count, 0) < 25 then 'inferred_sale'
    when existing_price is null then 'inferred_sale'
    when existing_price <= incoming_ceiling_price then 'inferred_sale'
    else 'dropped_from_cheapest_25'
  end;
$$;

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

create or replace function public.cardtrader_listing_stack_seller(
  seller_account_id text,
  seller_account_name text
)
returns text
language sql
immutable
parallel safe
as $$
  select coalesce(
    nullif(btrim(coalesce(seller_account_id, '')), ''),
    nullif(lower(btrim(coalesce(seller_account_name, ''))), '')
  );
$$;

create or replace function public.cardtrader_listing_is_graded(
  raw_metadata jsonb default '{}'::jsonb,
  properties jsonb default '{}'::jsonb
)
returns boolean
language sql
immutable
parallel safe
as $$
  select lower(coalesce(
    raw_metadata->>'graded',
    properties->>'graded',
    ''
  )) in ('true', '1', 'yes');
$$;

create or replace function public.cardtrader_same_seller_listing_stack(
  a_seller_id text,
  a_seller_name text,
  a_blueprint bigint,
  a_condition text,
  a_language text,
  a_properties jsonb,
  a_raw jsonb,
  b_seller_id text,
  b_seller_name text,
  b_blueprint bigint,
  b_condition text,
  b_language text,
  b_properties jsonb,
  b_raw jsonb
)
returns boolean
language sql
immutable
parallel safe
as $$
  select
    public.cardtrader_listing_stack_seller(a_seller_id, a_seller_name) is not null
    and public.cardtrader_listing_stack_seller(a_seller_id, a_seller_name)
      = public.cardtrader_listing_stack_seller(b_seller_id, b_seller_name)
    and a_blueprint is not distinct from b_blueprint
    and lower(btrim(coalesce(a_condition, '')))
      is not distinct from lower(btrim(coalesce(b_condition, '')))
    and lower(btrim(coalesce(a_language, '')))
      is not distinct from lower(btrim(coalesce(b_language, '')))
    and public.cardtrader_listing_is_reverse(coalesce(a_properties, '{}'::jsonb), false, '')
      is not distinct from public.cardtrader_listing_is_reverse(coalesce(b_properties, '{}'::jsonb), false, '')
    and public.cardtrader_listing_is_first_edition(coalesce(a_properties, '{}'::jsonb), false)
      is not distinct from public.cardtrader_listing_is_first_edition(coalesce(b_properties, '{}'::jsonb), false)
    and public.cardtrader_listing_is_graded(coalesce(a_raw, '{}'::jsonb), coalesce(a_properties, '{}'::jsonb))
      is not distinct from public.cardtrader_listing_is_graded(coalesce(b_raw, '{}'::jsonb), coalesce(b_properties, '{}'::jsonb));
$$;

create or replace function public.refresh_cardtrader_market_listing_snapshots(
  p_provider text,
  p_rows jsonb,
  p_scope_blueprint_ids jsonb default '[]'::jsonb,
  p_removed_day date default current_date - 1,
  p_archive_missing boolean default true,
  p_imported_at timestamptz default now(),
  p_finalize boolean default true,
  p_record_ask_observations boolean default false
)
returns table (
  archived_count integer,
  deleted_count integer,
  upserted_count integer,
  cache_refreshed_count integer
)
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
as $$
declare
  v_provider text := coalesce(nullif(trim(p_provider), ''), 'cardtrader');
  v_rows jsonb := coalesce(p_rows, '[]'::jsonb);
  v_scope_blueprint_ids jsonb := coalesce(p_scope_blueprint_ids, '[]'::jsonb);
  v_removed_day date := coalesce(p_removed_day, current_date - 1);
  v_cache_scope_blueprint_ids jsonb := '[]'::jsonb;
  v_cache_refreshed_count integer := 0;
  v_quantity_decreased_count integer := 0;
begin
  perform set_config('statement_timeout', '0', true);
  perform set_config('lock_timeout', '0', true);

  if jsonb_typeof(v_rows) <> 'array' then
    raise exception 'rows must be a JSONB array';
  end if;

  if jsonb_typeof(v_scope_blueprint_ids) <> 'array' then
    raise exception 'scope blueprint ids must be a JSONB array';
  end if;

  create temp table if not exists pg_temp.cardtrader_market_listing_refresh_rows (
    provider text not null,
    external_listing_id text not null,
    external_product_id text not null,
    blueprint_id bigint,
    cardtrader_blueprint_id bigint,
    pokoin_card_id text not null,
    seller_account_id text not null,
    seller_account_name text not null,
    seller_country text not null,
    seller_type text not null,
    quantity integer not null,
    condition text not null,
    language text not null,
    price numeric,
    price_cents integer,
    currency text not null,
    properties jsonb not null,
    raw_metadata jsonb not null
  ) on commit drop;

  create temp table if not exists pg_temp.cardtrader_market_listing_refresh_scope (
    blueprint_id bigint primary key
  ) on commit drop;

  create temp table if not exists pg_temp.cardtrader_market_listing_incoming_stats (
    blueprint_id bigint primary key,
    listing_count integer not null,
    ceiling_price numeric
  ) on commit drop;

  truncate table pg_temp.cardtrader_market_listing_refresh_rows;
  truncate table pg_temp.cardtrader_market_listing_refresh_scope;
  truncate table pg_temp.cardtrader_market_listing_incoming_stats;

  insert into pg_temp.cardtrader_market_listing_refresh_rows (
    provider,
    external_listing_id,
    external_product_id,
    blueprint_id,
    cardtrader_blueprint_id,
    pokoin_card_id,
    seller_account_id,
    seller_account_name,
    seller_country,
    seller_type,
    quantity,
    condition,
    language,
    price,
    price_cents,
    currency,
    properties,
    raw_metadata
  )
  select distinct on (v_provider, normalized.external_listing_id)
    v_provider,
    normalized.external_listing_id,
    normalized.external_product_id,
    normalized.blueprint_id,
    normalized.cardtrader_blueprint_id,
    normalized.pokoin_card_id,
    normalized.seller_account_id,
    normalized.seller_account_name,
    normalized.seller_country,
    normalized.seller_type,
    normalized.quantity,
    normalized.condition,
    normalized.language,
    normalized.price,
    normalized.price_cents,
    normalized.currency,
    normalized.properties,
    normalized.raw_metadata
  from (
    select
      left(coalesce(row_data->>'externalListingId', row_data->>'external_listing_id', row_data->>'id', ''), 160) as external_listing_id,
      left(coalesce(row_data->>'externalProductId', row_data->>'external_product_id', row_data->>'productId', row_data->>'product_id', ''), 160) as external_product_id,
      nullif(coalesce(row_data->>'blueprintId', row_data->>'blueprint_id', ''), '')::bigint as blueprint_id,
      nullif(coalesce(row_data->>'cardtraderBlueprintId', row_data->>'cardtrader_blueprint_id', row_data->>'blueprintId', row_data->>'blueprint_id', ''), '')::bigint as cardtrader_blueprint_id,
      left(coalesce(
        nullif(row_data->>'pokoinCardId', ''),
        nullif(row_data->>'pokoin_card_id', ''),
        (nullif(coalesce(row_data->>'blueprintId', row_data->>'blueprint_id', ''), '')::bigint * 2)::text,
        ''
      ), 80) as pokoin_card_id,
      left(coalesce(row_data->>'sellerAccountId', row_data->>'seller_account_id', ''), 160) as seller_account_id,
      left(coalesce(row_data->>'sellerAccountName', row_data->>'seller_account_name', ''), 240) as seller_account_name,
      left(coalesce(row_data->>'sellerCountry', row_data->>'seller_country', ''), 40) as seller_country,
      left(coalesce(row_data->>'sellerType', row_data->>'seller_type', ''), 80) as seller_type,
      greatest(coalesce(nullif(coalesce(row_data->>'quantity', row_data->>'qty', ''), '')::integer, 0), 0) as quantity,
      left(coalesce(row_data->>'condition', row_data->>'state', ''), 80) as condition,
      left(coalesce(row_data->>'language', row_data->>'lang', ''), 40) as language,
      nullif(coalesce(row_data->>'price', row_data->>'priceAmount', row_data->>'price_amount', ''), '')::numeric as price,
      nullif(coalesce(row_data->>'priceCents', row_data->>'price_cents', ''), '')::integer as price_cents,
      left(coalesce(row_data->>'currency', ''), 12) as currency,
      coalesce(row_data->'properties', '{}'::jsonb) as properties,
      coalesce(row_data->'rawMetadata', row_data->'raw_metadata', row_data, '{}'::jsonb) as raw_metadata
    from jsonb_array_elements(v_rows) as payload(row_data)
  ) normalized
  where normalized.external_listing_id <> ''
  order by v_provider, normalized.external_listing_id;

  insert into pg_temp.cardtrader_market_listing_refresh_scope (blueprint_id)
  select distinct value::bigint
  from jsonb_array_elements_text(v_scope_blueprint_ids) as scope(value)
  where value ~ '^[0-9]+$'
  on conflict do nothing;

  insert into pg_temp.cardtrader_market_listing_refresh_scope (blueprint_id)
  select distinct coalesce(blueprint_id, cardtrader_blueprint_id)
  from pg_temp.cardtrader_market_listing_refresh_rows
  where coalesce(blueprint_id, cardtrader_blueprint_id) is not null
  on conflict do nothing;

  insert into pg_temp.cardtrader_market_listing_incoming_stats (
    blueprint_id,
    listing_count,
    ceiling_price
  )
  select
    coalesce(blueprint_id, cardtrader_blueprint_id) as blueprint_id,
    count(*)::integer,
    case
      when current_setting('app.cardtrader_complete_book', true) in ('1', 'true', 'on')
        then null
      else max(coalesce(price, price_cents::numeric / 100))
    end
  from pg_temp.cardtrader_market_listing_refresh_rows
  where coalesce(blueprint_id, cardtrader_blueprint_id) is not null
  group by coalesce(blueprint_id, cardtrader_blueprint_id)
  on conflict do nothing;

  perform public.cardtrader_upsert_seller_vacation_from_refresh(v_provider, p_imported_at);

  if exists (select 1 from pg_temp.cardtrader_market_listing_refresh_scope) then
    insert into public.cardtrader_market_listing_removed_history (
      provider,
      external_listing_id,
      external_product_id,
      blueprint_id,
      cardtrader_blueprint_id,
      pokoin_card_id,
      seller_account_id,
      seller_account_name,
      seller_country,
      seller_type,
      quantity,
      condition,
      language,
      price,
      price_cents,
      currency,
      properties,
      raw_metadata,
      first_seen_at,
      last_seen_at,
      imported_at,
      last_snapshot_updated_at,
      removed_day,
      archive_reason,
      archive_metadata
    )
    select
      existing.provider,
      existing.external_listing_id,
      existing.external_product_id,
      existing.blueprint_id,
      existing.cardtrader_blueprint_id,
      existing.pokoin_card_id,
      existing.seller_account_id,
      existing.seller_account_name,
      existing.seller_country,
      existing.seller_type,
      greatest(existing.quantity - incoming.quantity, 0),
      existing.condition,
      existing.language,
      existing.price,
      existing.price_cents,
      existing.currency,
      existing.properties,
      existing.raw_metadata,
      existing.first_seen_at,
      existing.last_seen_at,
      existing.imported_at,
      existing.updated_at,
      v_removed_day,
      'quantity_decreased',
      jsonb_build_object(
        'refreshImportedAt', p_imported_at,
        'previousQuantity', existing.quantity,
        'currentQuantity', incoming.quantity
      )
    from public.cardtrader_market_listing_snapshots existing
    join pg_temp.cardtrader_market_listing_refresh_rows incoming
      on incoming.provider = existing.provider
      and incoming.external_listing_id = existing.external_listing_id
    join pg_temp.cardtrader_market_listing_refresh_scope scope
      on scope.blueprint_id = coalesce(existing.blueprint_id, existing.cardtrader_blueprint_id)
    where existing.provider = v_provider
      and existing.quantity > incoming.quantity
      and not public.cardtrader_listing_is_on_vacation(incoming.raw_metadata)
      and not public.cardtrader_seller_is_on_vacation(v_provider, existing.seller_account_id)
    on conflict (provider, external_listing_id, removed_day) do nothing;

    get diagnostics v_quantity_decreased_count = row_count;
  end if;

  if p_archive_missing and exists (select 1 from pg_temp.cardtrader_market_listing_refresh_scope) then
    insert into public.cardtrader_market_listing_removed_history (
      provider,
      external_listing_id,
      external_product_id,
      blueprint_id,
      cardtrader_blueprint_id,
      pokoin_card_id,
      seller_account_id,
      seller_account_name,
      seller_country,
      seller_type,
      quantity,
      condition,
      language,
      price,
      price_cents,
      currency,
      properties,
      raw_metadata,
      first_seen_at,
      last_seen_at,
      imported_at,
      last_snapshot_updated_at,
      removed_day,
      archive_reason,
      archive_metadata
    )
    select
      existing.provider,
      existing.external_listing_id,
      existing.external_product_id,
      existing.blueprint_id,
      existing.cardtrader_blueprint_id,
      existing.pokoin_card_id,
      existing.seller_account_id,
      existing.seller_account_name,
      existing.seller_country,
      existing.seller_type,
      existing.quantity,
      existing.condition,
      existing.language,
      existing.price,
      existing.price_cents,
      existing.currency,
      existing.properties,
      existing.raw_metadata,
      existing.first_seen_at,
      existing.last_seen_at,
      existing.imported_at,
      existing.updated_at,
      v_removed_day,
      case
        when exists (
          select 1
          from pg_temp.cardtrader_market_listing_refresh_rows successor
          where successor.provider = existing.provider
            and successor.external_listing_id is distinct from existing.external_listing_id
            and public.cardtrader_same_seller_listing_stack(
              existing.seller_account_id,
              existing.seller_account_name,
              coalesce(existing.blueprint_id, existing.cardtrader_blueprint_id),
              existing.condition,
              existing.language,
              existing.properties,
              existing.raw_metadata,
              successor.seller_account_id,
              successor.seller_account_name,
              coalesce(successor.blueprint_id, successor.cardtrader_blueprint_id),
              successor.condition,
              successor.language,
              successor.properties,
              successor.raw_metadata
            )
        ) then 'listing_id_rotated'
        when public.cardtrader_seller_is_on_vacation(
          existing.provider,
          existing.seller_account_id
        ) then 'seller_on_vacation'
        else 'inferred_sale'
      end,
      jsonb_build_object(
        'refreshImportedAt', p_imported_at,
        'incomingListingCount', coalesce(stats.listing_count, 0),
        'incomingCeilingPrice', stats.ceiling_price
      ) || case
        when exists (
          select 1
          from pg_temp.cardtrader_market_listing_refresh_rows successor
          where successor.provider = existing.provider
            and successor.external_listing_id is distinct from existing.external_listing_id
            and public.cardtrader_same_seller_listing_stack(
              existing.seller_account_id,
              existing.seller_account_name,
              coalesce(existing.blueprint_id, existing.cardtrader_blueprint_id),
              existing.condition,
              existing.language,
              existing.properties,
              existing.raw_metadata,
              successor.seller_account_id,
              successor.seller_account_name,
              coalesce(successor.blueprint_id, successor.cardtrader_blueprint_id),
              successor.condition,
              successor.language,
              successor.properties,
              successor.raw_metadata
            )
        ) then jsonb_build_object('reclassifiedBecause', 'seller_stack_still_listed')
        when public.cardtrader_seller_is_on_vacation(
          existing.provider,
          existing.seller_account_id
        ) then jsonb_build_object('reclassifiedBecause', 'seller_on_vacation')
        else '{}'::jsonb
      end
    from public.cardtrader_market_listing_snapshots existing
    join pg_temp.cardtrader_market_listing_refresh_scope scope
      on scope.blueprint_id = coalesce(existing.blueprint_id, existing.cardtrader_blueprint_id)
    left join pg_temp.cardtrader_market_listing_refresh_rows incoming
      on incoming.provider = existing.provider
      and incoming.external_listing_id = existing.external_listing_id
    left join pg_temp.cardtrader_market_listing_incoming_stats stats
      on stats.blueprint_id = coalesce(existing.blueprint_id, existing.cardtrader_blueprint_id)
    where existing.provider = v_provider
      and incoming.external_listing_id is null
      and not public.cardtrader_seller_is_on_vacation(
        existing.provider,
        existing.seller_account_id
      )
    on conflict (provider, external_listing_id, removed_day) do nothing;

    get diagnostics archived_count = row_count;
    archived_count := coalesce(archived_count, 0) + coalesce(v_quantity_decreased_count, 0);

    delete from public.cardtrader_market_listing_snapshots existing
    using pg_temp.cardtrader_market_listing_refresh_scope scope
    where existing.provider = v_provider
      and scope.blueprint_id = coalesce(existing.blueprint_id, existing.cardtrader_blueprint_id)
      and not exists (
        select 1
        from pg_temp.cardtrader_market_listing_refresh_rows incoming
        where incoming.provider = existing.provider
          and incoming.external_listing_id = existing.external_listing_id
      )
      and not public.cardtrader_seller_is_on_vacation(
        existing.provider,
        existing.seller_account_id
      );

    get diagnostics deleted_count = row_count;
  else
    archived_count := coalesce(v_quantity_decreased_count, 0);
    deleted_count := 0;
  end if;

  insert into public.cardtrader_market_listing_snapshots (
    provider,
    external_listing_id,
    external_product_id,
    blueprint_id,
    cardtrader_blueprint_id,
    pokoin_card_id,
    seller_account_id,
    seller_account_name,
    seller_country,
    seller_type,
    quantity,
    condition,
    language,
    price,
    price_cents,
    currency,
    properties,
    raw_metadata,
    first_seen_at,
    last_seen_at,
    imported_at,
    updated_at
  )
  select
    incoming.provider,
    incoming.external_listing_id,
    incoming.external_product_id,
    incoming.blueprint_id,
    incoming.cardtrader_blueprint_id,
    incoming.pokoin_card_id,
    incoming.seller_account_id,
    incoming.seller_account_name,
    incoming.seller_country,
    incoming.seller_type,
    incoming.quantity,
    incoming.condition,
    incoming.language,
    incoming.price,
    incoming.price_cents,
    incoming.currency,
    incoming.properties,
    incoming.raw_metadata,
    p_imported_at,
    p_imported_at,
    p_imported_at,
    p_imported_at
  from pg_temp.cardtrader_market_listing_refresh_rows incoming
  on conflict (provider, external_listing_id) do update set
    external_product_id = excluded.external_product_id,
    blueprint_id = excluded.blueprint_id,
    cardtrader_blueprint_id = excluded.cardtrader_blueprint_id,
    pokoin_card_id = excluded.pokoin_card_id,
    seller_account_id = excluded.seller_account_id,
    seller_account_name = excluded.seller_account_name,
    seller_country = excluded.seller_country,
    seller_type = excluded.seller_type,
    quantity = excluded.quantity,
    condition = excluded.condition,
    language = excluded.language,
    price = excluded.price,
    price_cents = excluded.price_cents,
    currency = excluded.currency,
    properties = excluded.properties,
    raw_metadata = excluded.raw_metadata,
    last_seen_at = excluded.last_seen_at,
    imported_at = excluded.imported_at,
    updated_at = excluded.updated_at;

  get diagnostics upserted_count = row_count;

  select coalesce(jsonb_agg(scope.blueprint_id), '[]'::jsonb)
  from pg_temp.cardtrader_market_listing_refresh_scope scope
  into v_cache_scope_blueprint_ids;

  -- Homepage cache is rebuilt once in finalize_cardtrader_daily_market_refresh.
  -- Per-expansion cache refresh is too expensive for 800+ expansions.
  if p_finalize and jsonb_array_length(coalesce(v_cache_scope_blueprint_ids, '[]'::jsonb)) > 0 then
    select public.refresh_cardtrader_blueprint_listing_cache(
      v_provider,
      v_cache_scope_blueprint_ids,
      p_imported_at
    )
    into v_cache_refreshed_count;
  end if;

  cache_refreshed_count := coalesce(v_cache_refreshed_count, 0);

  if p_record_ask_observations then
    insert into public.marketplace_price_observations (
      blueprint_id,
      source,
      source_item_id,
      observed_at,
      currency,
      price,
      price_pkn,
      quantity,
      condition,
      language,
      reverse,
      first_edition,
      foil_state,
      variant_state,
      sealed,
      signed,
      graded,
      grading_company,
      grade,
      metadata,
      created_at
    )
    select
      coalesce(snapshot.blueprint_id, snapshot.cardtrader_blueprint_id),
      'cardtrader_snapshot',
      snapshot.provider || ':' || snapshot.external_listing_id || ':' || p_imported_at::date::text,
      p_imported_at,
      coalesce(nullif(snapshot.currency, ''), 'EUR'),
      coalesce(snapshot.price, snapshot.price_cents::numeric / 100),
      public.marketplace_price_pkn_from_cardtrader(snapshot.price, snapshot.price_cents, snapshot.currency),
      snapshot.quantity,
      coalesce(nullif(snapshot.condition, ''), 'NM'),
      public.cardtrader_listing_language_for_blueprint(
        snapshot.language,
        coalesce(snapshot.properties, '{}'::jsonb),
        coalesce(snapshot.blueprint_id, snapshot.cardtrader_blueprint_id)
      ),
      public.cardtrader_listing_is_reverse(
        coalesce(snapshot.properties, '{}'::jsonb),
        false,
        coalesce(snapshot.properties->>'foil_state', snapshot.properties->>'foilState', '')
      ),
      public.cardtrader_listing_is_first_edition(
        coalesce(snapshot.properties, '{}'::jsonb),
        false
      ),
      case when lower(coalesce(snapshot.properties->>'foil_state', snapshot.properties->>'foilState', '')) = 'reverse' then 'reverse' else 'standard' end,
      coalesce(snapshot.properties->>'variant_state', snapshot.properties->>'variantState', ''),
      false,
      false,
      lower(coalesce(snapshot.raw_metadata->>'graded', '')) in ('true', '1', 'yes'),
      '',
      '',
      jsonb_build_object(
        'provider', snapshot.provider,
        'sellerAccountId', snapshot.seller_account_id,
        'observationKind', 'global_market_listing_snapshot',
        'observedDay', p_imported_at::date
      ),
      p_imported_at
    from public.cardtrader_market_listing_snapshots snapshot
    join pg_temp.cardtrader_market_listing_refresh_scope scope
      on scope.blueprint_id = coalesce(snapshot.blueprint_id, snapshot.cardtrader_blueprint_id)
    where snapshot.provider = v_provider
      and coalesce(snapshot.blueprint_id, snapshot.cardtrader_blueprint_id) is not null
      and snapshot.quantity > 0
      and public.marketplace_price_pkn_from_cardtrader(snapshot.price, snapshot.price_cents, snapshot.currency) is not null
      and not exists (
        select 1
        from public.marketplace_price_observations existing
        where existing.source = 'cardtrader_snapshot'
          and existing.source_item_id = snapshot.provider || ':' || snapshot.external_listing_id || ':' || p_imported_at::date::text
      );
  end if;

  insert into public.marketplace_price_observations (
    blueprint_id,
    source,
    source_item_id,
    observed_at,
    currency,
    price,
    price_pkn,
    quantity,
    condition,
    language,
    reverse,
    first_edition,
    foil_state,
    variant_state,
    sealed,
    signed,
    graded,
    grading_company,
    grade,
    metadata,
    created_at
  )
  select
    coalesce(history.blueprint_id, history.cardtrader_blueprint_id),
    'cardtrader_removed_sale',
    history.provider || ':' || history.external_listing_id || ':' || history.removed_day::text || ':' || history.archive_reason,
    history.removed_day::timestamptz,
    coalesce(nullif(history.currency, ''), 'EUR'),
    coalesce(history.price, history.price_cents::numeric / 100),
    public.marketplace_price_pkn_from_cardtrader(history.price, history.price_cents, history.currency),
    history.quantity,
    coalesce(nullif(history.condition, ''), 'NM'),
    public.cardtrader_listing_language_for_blueprint(
      history.language,
      coalesce(history.properties, '{}'::jsonb),
      coalesce(history.blueprint_id, history.cardtrader_blueprint_id)
    ),
    public.cardtrader_listing_is_reverse(
      coalesce(history.properties, '{}'::jsonb),
      false,
      coalesce(history.properties->>'foil_state', history.properties->>'foilState', '')
    ),
    public.cardtrader_listing_is_first_edition(
      coalesce(history.properties, '{}'::jsonb),
      false
    ),
    case when lower(coalesce(history.properties->>'foil_state', history.properties->>'foilState', '')) = 'reverse' then 'reverse' else 'standard' end,
    coalesce(history.properties->>'variant_state', history.properties->>'variantState', ''),
    false,
    false,
    lower(coalesce(history.raw_metadata->>'graded', '')) in ('true', '1', 'yes'),
    '',
    '',
    jsonb_build_object(
      'provider', history.provider,
      'sellerAccountId', history.seller_account_id,
      'sellerAccountName', history.seller_account_name,
      'externalListingId', history.external_listing_id,
      'observationKind', 'global_market_listing_removed_or_sold',
      'observedDay', history.removed_day,
      'removedDay', history.removed_day,
      'archiveReason', history.archive_reason
    ),
    now()
  from public.cardtrader_market_listing_removed_history history
  where history.provider = v_provider
    and history.removed_day = v_removed_day
    and public.cardtrader_market_is_sale_reason(history.archive_reason)
    and coalesce(history.blueprint_id, history.cardtrader_blueprint_id) is not null
    and public.marketplace_price_pkn_from_cardtrader(history.price, history.price_cents, history.currency) is not null
    and (
      jsonb_array_length(v_cache_scope_blueprint_ids) = 0
      or coalesce(history.blueprint_id, history.cardtrader_blueprint_id) in (
        select scope.blueprint_id from pg_temp.cardtrader_market_listing_refresh_scope scope
      )
    )
    and not exists (
      select 1
      from public.marketplace_price_observations existing
      where existing.source = 'cardtrader_removed_sale'
        and existing.source_item_id = history.provider || ':' || history.external_listing_id || ':' || history.removed_day::text || ':' || history.archive_reason
    );

  if p_finalize then
    perform public.refresh_cardtrader_blueprint_daily_analytics(v_removed_day);
    perform public.refresh_marketplace_blueprint_price_summary(blueprint_id::text)
    from (
      select distinct coalesce(blueprint_id, cardtrader_blueprint_id) as blueprint_id
      from public.cardtrader_market_listing_snapshots
      where provider = v_provider
        and coalesce(blueprint_id, cardtrader_blueprint_id) is not null
        and coalesce(blueprint_id, cardtrader_blueprint_id) in (
          select scope.blueprint_id from pg_temp.cardtrader_market_listing_refresh_scope scope
        )
      union
      select distinct coalesce(blueprint_id, cardtrader_blueprint_id) as blueprint_id
      from public.cardtrader_market_listing_removed_history
      where provider = v_provider
        and removed_day = v_removed_day
        and coalesce(blueprint_id, cardtrader_blueprint_id) is not null
        and public.cardtrader_market_is_sale_reason(archive_reason)
    ) touched_blueprints;
    perform public.refresh_marketplace_hot_blueprints();
  end if;

  return next;
end;
$$;


create or replace function public.finalize_cardtrader_daily_market_refresh(
  p_provider text default 'cardtrader',
  p_removed_day date default current_date - 1,
  p_imported_at timestamptz default now()
)
returns table (
  cache_refreshed_count integer,
  analytics_count integer,
  price_summary_count integer
)
language plpgsql
security definer
set search_path = public
set statement_timeout = 0
as $$
declare
  v_provider text := coalesce(nullif(trim(p_provider), ''), 'cardtrader');
  v_day date := coalesce(p_removed_day, current_date - 1);
begin
  perform set_config('statement_timeout', '0', true);
  perform set_config('lock_timeout', '0', true);

  select public.refresh_cardtrader_blueprint_listing_cache(v_provider, '[]'::jsonb, p_imported_at)
  into cache_refreshed_count;

  perform public.annotate_cardtrader_removed_sale_observations(v_day);
  perform public.cardtrader_reclassify_vacation_vanished_sellers(v_provider, v_day);
  perform public.refresh_cardtrader_sold_daily(v_day);

  select public.refresh_cardtrader_blueprint_daily_analytics(v_day)
  into analytics_count;

  select public.refresh_marketplace_blueprint_price_summary(null)
  into price_summary_count;

  perform public.refresh_marketplace_hot_blueprints();

  return next;
end;
$$;

commit;
