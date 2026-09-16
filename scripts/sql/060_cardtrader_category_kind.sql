-- CardTrader already stores category_id on pokoin_pokemon_blueprints.
-- Fresh Pokemon dumps often leave blueprint.category_name empty, so the
-- name classifier fell through to product_type=card (30th Celebration
-- frames, boxes, condition markers). Prefer CT category ids. Qwen-VL
-- leftovers write marketplace_visual_kind and win over both. Category 73/78
-- (singles / jumbo cards) must still recast stale name-classifier tins
-- (Victini, Fighting Energy, Giratina: the substring "tin").

set statement_timeout = 0;

create table if not exists public.marketplace_visual_kind (
  ct_id bigint primary key references public.pokoin_pokemon_blueprints(id) on delete cascade,
  item_kind text not null check (item_kind = any (array['single'::text, 'product'::text])),
  product_type text not null,
  model text not null default 'qwen3-vl:32b-instruct',
  why text not null default '',
  image_key text not null default '',
  classified_at timestamptz not null default now()
);

create or replace function public.cardtrader_pokemon_category_product_type(category_id integer)
returns text
language sql
immutable
as $$
  select case category_id
    when 73 then 'card'              -- Pokémon Singles
    when 78 then 'card'              -- Pokémon Oversized (jumbo card)
    when 59 then 'tin'               -- Pokémon Tins
    when 60 then 'collection_box'    -- Pokémon Box Set
    when 61 then 'accessory'         -- Pokémon Memorabilia
    when 62 then 'accessory'         -- Pokémon Sleeves
    when 63 then 'accessory'         -- Pokémon Playmats
    when 64 then 'accessory'         -- Pokémon Deck Boxes
    when 65 then 'accessory'         -- Pokémon Albums
    when 66 then 'booster_pack'      -- Pokémon Booster
    when 67 then 'booster_box'       -- Pokémon Booster Box
    when 68 then 'booster_bundle'    -- Pokémon Bundle
    when 69 then 'deck'              -- Pokémon Preconstructed Deck
    when 74 then 'accessory'         -- Pokémon Dividers
    when 86 then 'accessory'         -- Pokémon Dice
    when 118 then 'accessory'        -- Pokémon Empty Boxes & Storage
    when 136 then 'sealed_product'   -- Pokémon Complete Set
    when 190 then 'sealed_product'   -- Pokémon Blisters
    when 203 then 'accessory'        -- binder pages (not in pokemon-categories.json)
    when 211 then 'accessory'        -- one-touch
    else case when category_id is null then null else 'sealed_product' end
  end;
$$;

create or replace function public.resolved_marketplace_product_type(
  card_name text,
  expansion_name text default ''::text,
  category_name text default ''::text,
  blueprint_type text default ''::text,
  card_number text default ''::text,
  version text default ''::text,
  blueprint_id bigint default null,
  category_id integer default null
)
returns text
language sql
stable
as $$
  select coalesce(
    (select v.product_type from public.marketplace_visual_kind v where v.ct_id = blueprint_id),
    public.cardtrader_pokemon_category_product_type(category_id),
    public.classify_marketplace_product_type(
      card_name,
      expansion_name,
      category_name,
      blueprint_type,
      card_number,
      version,
      blueprint_id
    )
  );
$$;

create or replace function public.apply_cardtrader_category_kind()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  cards_n integer := 0;
  candidates_n integer := 0;
  versions_n integer := 0;
  counts_n integer := 0;
begin
  update public.marketplace_cards c
  set
    product_type = r.product_type,
    item_kind = case when r.product_type = 'card' then 'single' else 'product' end,
    projected_at = now()
  from public.pokoin_pokemon_blueprints b
  left join public.marketplace_visual_kind v on v.ct_id = b.id
  cross join lateral (
    select coalesce(
      v.product_type,
      public.cardtrader_pokemon_category_product_type(b.category_id)
    ) as product_type
  ) r
  where b.id = c.ct_id
    and r.product_type is not null
    and (
      c.product_type is distinct from r.product_type
      or c.item_kind is distinct from (case when r.product_type = 'card' then 'single' else 'product' end)
    );

  get diagnostics cards_n = row_count;

  update public.marketplace_search_candidates s
  set
    item_kind = c.item_kind,
    product_type = c.product_type,
    search_text = lower(concat_ws(
      ' ',
      c.name,
      c.set_name,
      c.card_number,
      c.product_variant,
      c.rarity,
      c.card_type,
      c.item_kind,
      c.product_type,
      c.trainer_name,
      array_to_string(coalesce(t.aliases, '{}'::text[]), ' ')
    )),
    search_weight = (
      case when c.item_kind = 'product' then 12 else 0 end +
      case when c.rarity ilike '%rare%' then 8 else 0 end +
      case when c.name ~* '(^|[^a-z0-9])(ex|vmax|vstar|gx|lv\.x)([^a-z0-9]|$)' then 10 else 0 end +
      case when c.card_number ~ '/' then 10 else 0 end +
      case when c.trainer_name <> '' then 6 else 0 end +
      case when c.preview_image_url is not null then 4 else 0 end
    )::numeric,
    projected_at = now()
  from public.marketplace_cards c
  left join public.marketplace_trainers t on lower(t.trainer_name) = lower(c.trainer_name)
  where s.card_id = c.card_id
    and (s.item_kind, s.product_type) is distinct from (c.item_kind, c.product_type);

  get diagnostics candidates_n = row_count;

  update public.marketplace_card_versions versions
  set
    product_type = c.product_type,
    projected_at = now()
  from public.marketplace_cards c
  where versions.ct_id = c.ct_id
    and versions.product_type is distinct from c.product_type;

  get diagnostics versions_n = row_count;

  counts_n := public.refresh_marketplace_set_catalog_counts();

  return jsonb_build_object(
    'marketplaceCards', cards_n,
    'searchCandidates', candidates_n,
    'marketplaceCardVersions', versions_n,
    'setCatalogCounts', counts_n
  );
end;
$$;

CREATE OR REPLACE FUNCTION public.refresh_marketplace_cards_from_blueprints()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  refreshed_count integer;
begin
  alter table public.pokoin_pokemon_blueprints
    add column if not exists emoji text not null default '';

  alter table public.marketplace_cards
    add column if not exists product_variant text not null default '';
  alter table public.marketplace_cards
    add column if not exists card_palette jsonb not null default '{}'::jsonb;
  alter table public.marketplace_cards
    add column if not exists emoji text not null default '';
  alter table public.marketplace_cards
    add column if not exists ct_id bigint;
  perform public.marketplace_seed_cards_type();

  alter table public.marketplace_card_names
    add column if not exists emoji text not null default '';

  insert into public.marketplace_card_names (name, normalized_name, compact_name, emoji, name_tokens, updated_at)
  select
    name,
    public.marketplace_search_normalize(name),
    public.marketplace_search_compact(name),
    public.marketplace_card_name_emoji(name),
    public.marketplace_search_tokenize(name),
    now()
  from (select distinct name from public.pokoin_pokemon_blueprints where name <> '') source
  on conflict (name) do update set
    normalized_name = excluded.normalized_name,
    compact_name = excluded.compact_name,
    emoji = excluded.emoji,
    name_tokens = excluded.name_tokens,
    updated_at = now();

  perform public.marketplace_seed_cards_name_type();

  update public.pokoin_pokemon_blueprints b
  set
    card_palette = public.marketplace_card_palette(
      coalesce(nullif(b.blueprint->>'card_type', ''), nullif(b.blueprint->>'type', ''), nullif(b.blueprint->>'category_name', ''), 'Trading card'),
      b.name,
      coalesce(nullif(b.blueprint->>'rarity', ''), nullif(b.blueprint->>'collector_rarity', ''), 'Card'),
      concat_ws(' ', coalesce(nullif(b.expansion->>'name', ''), nullif(b.blueprint->>'expansion_name', ''), 'Pokemon'), b.version)
    ),
    emoji = concat_ws(
      ' ',
      nullif(n.emoji, ''),
      public.marketplace_card_variant_emoji(
        b.name,
        coalesce(nullif(b.blueprint->>'rarity', ''), nullif(b.blueprint->>'collector_rarity', ''), 'Card'),
        b.version
      )
    )
  from public.marketplace_card_names n
  where n.name = b.name;

  insert into public.marketplace_cards (
    card_id, ct_id, name, version, product_variant, image_url, cdn_image_url, preview_image_url,
    set_name, rarity, card_type, card_number, is_holo, is_foil,
    imported_at, projected_at, item_kind, product_type, trainer_name, card_palette, emoji
  )
  select
    public.pokoin_public_number(source.id),
    source.id,
    source.name,
    source.version,
    case when source.product_type = 'card' then '' else coalesce(source.version, '') end,
    source.image_url,
    source.cdn_image_url,
    source.preview_image_url,
    source.set_name,
    source.rarity,
    source.card_type,
    case when source.product_type = 'card' then coalesce(source.explicit_card_number, source.version, source.id::text) else coalesce(source.explicit_card_number, '') end,
    lower(coalesce(source.rarity, '')) like '%holo%',
    lower(coalesce(source.rarity, '')) like '%holo%',
    source.imported_at,
    now(),
    case when source.product_type = 'card' then 'single' else 'product' end,
    source.product_type,
    source.trainer_name,
    source.card_palette,
    source.emoji
  from (
    select
      b.id,
      b.name,
      b.version,
      b.image_url,
      b.cdn_image_url,
      b.preview_image_url,
      coalesce(nullif(b.expansion->>'name', ''), nullif(b.blueprint->>'expansion_name', ''), 'Pokemon') as set_name,
      coalesce(nullif(b.blueprint->>'rarity', ''), nullif(b.blueprint->>'collector_rarity', ''), 'Card') as rarity,
      coalesce(nullif(b.blueprint->>'card_type', ''), nullif(b.blueprint->>'type', ''), nullif(b.blueprint->>'category_name', ''), 'Trading card') as card_type,
      coalesce(nullif(b.blueprint->>'number', ''), nullif(b.blueprint->>'collector_number', ''), nullif(b.blueprint->>'card_number', '')) as explicit_card_number,
      public.resolved_marketplace_product_type(
        b.name,
        coalesce(nullif(b.expansion->>'name', ''), nullif(b.blueprint->>'expansion_name', ''), 'Pokemon'),
        b.blueprint->>'category_name',
        b.blueprint->>'type',
        coalesce(nullif(b.blueprint->>'number', ''), nullif(b.blueprint->>'collector_number', ''), nullif(b.blueprint->>'card_number', ''), b.version, b.id::text),
        b.version,
        b.id,
        b.category_id
      ) as product_type,
      coalesce(nullif(b.blueprint->>'trainer_name', ''), '') as trainer_name,
      public.marketplace_card_palette(
        coalesce(nullif(b.blueprint->>'card_type', ''), nullif(b.blueprint->>'type', ''), nullif(b.blueprint->>'category_name', ''), 'Trading card'),
        b.name,
        coalesce(nullif(b.blueprint->>'rarity', ''), nullif(b.blueprint->>'collector_rarity', ''), 'Card'),
        concat_ws(' ', coalesce(nullif(b.expansion->>'name', ''), nullif(b.blueprint->>'expansion_name', ''), 'Pokemon'), b.version)
      ) as card_palette,
      coalesce(
        nullif(b.emoji, ''),
        public.marketplace_card_emoji(
          coalesce(nullif(b.blueprint->>'card_type', ''), nullif(b.blueprint->>'type', ''), nullif(b.blueprint->>'category_name', ''), 'Trading card'),
          b.name,
          coalesce(nullif(b.blueprint->>'rarity', ''), nullif(b.blueprint->>'collector_rarity', ''), 'Card'),
          b.version
        )
      ) as emoji,
      b.imported_at
    from public.pokoin_pokemon_blueprints b
  ) source
  where coalesce(source.preview_image_url, source.cdn_image_url, source.image_url) is not null
  on conflict (card_id) do update set
    ct_id = excluded.ct_id,
    name = excluded.name,
    version = excluded.version,
    product_variant = excluded.product_variant,
    image_url = excluded.image_url,
    cdn_image_url = excluded.cdn_image_url,
    preview_image_url = excluded.preview_image_url,
    set_name = excluded.set_name,
    rarity = excluded.rarity,
    card_type = excluded.card_type,
    card_number = excluded.card_number,
    is_holo = excluded.is_holo,
    is_foil = excluded.is_foil,
    imported_at = excluded.imported_at,
    projected_at = now(),
    item_kind = excluded.item_kind,
    product_type = excluded.product_type,
    trainer_name = excluded.trainer_name,
    card_palette = excluded.card_palette,
    emoji = excluded.emoji;

  get diagnostics refreshed_count = row_count;
  return refreshed_count;
end;
$function$;

select public.apply_cardtrader_category_kind();
