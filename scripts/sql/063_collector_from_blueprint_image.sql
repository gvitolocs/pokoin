-- CardTrader commons often store a catalog version id (12420) as
-- marketplace_cards.card_number when blueprint.number is empty. The printed
-- n/m is still in the original image filename (numel-1-34-double-crisis).
-- Parse the basename only — the path directory is the CT id.

set statement_timeout = 0;

create or replace function public.marketplace_collector_from_image_url(value text)
returns text
language plpgsql
immutable
as $$
declare
  base text;
  matched text[];
begin
  base := regexp_replace(regexp_replace(coalesce(value, ''), '[?#].*$', ''), '^.*/', '');
  matched := regexp_match(base, '(?:^|-)([0-9]{1,4}[A-Za-z]?)-([0-9]{2,4})(?:[-.]|$)');
  if matched is null then
    return '';
  end if;
  return matched[1] || '/' || matched[2];
end;
$$;

create or replace function public.marketplace_cards_resolve_printed_number()
returns trigger
language plpgsql
as $$
declare
  recovered text;
  blueprint_image text;
begin
  if new.product_type is distinct from 'card' then
    return new;
  end if;
  if coalesce(new.card_number, '') !~ '^[0-9]{4,}$' then
    return new;
  end if;
  select b.blueprint#>>'{image,url}' into blueprint_image
  from public.pokoin_pokemon_blueprints b
  where b.id = new.ct_id;
  recovered := coalesce(
    nullif(public.marketplace_collector_from_image_url(blueprint_image), ''),
    nullif(public.marketplace_collector_from_image_url(new.cdn_image_url), ''),
    nullif(public.marketplace_collector_from_image_url(new.image_url), ''),
    nullif(public.marketplace_collector_from_image_url(new.preview_image_url), '')
  );
  if recovered <> '' then
    new.card_number := recovered;
  end if;
  return new;
end;
$$;

drop trigger if exists marketplace_cards_resolve_printed_number on public.marketplace_cards;
create trigger marketplace_cards_resolve_printed_number
before insert or update of card_number, cdn_image_url, image_url, preview_image_url, ct_id, product_type
on public.marketplace_cards
for each row
execute function public.marketplace_cards_resolve_printed_number();

update public.marketplace_cards c
set card_number = recovered.collector
from (
  select
    cards.card_id,
    coalesce(
      nullif(public.marketplace_collector_from_image_url(b.blueprint#>>'{image,url}'), ''),
      nullif(public.marketplace_collector_from_image_url(cards.cdn_image_url), ''),
      nullif(public.marketplace_collector_from_image_url(cards.image_url), ''),
      nullif(public.marketplace_collector_from_image_url(cards.preview_image_url), '')
    ) as collector
  from public.marketplace_cards cards
  left join public.pokoin_pokemon_blueprints b on b.id = cards.ct_id
  where cards.product_type = 'card'
    and coalesce(cards.card_number, '') ~ '^[0-9]{4,}$'
) recovered
where c.card_id = recovered.card_id
  and recovered.collector ~ '^[0-9]{1,4}[A-Za-z]?/[0-9]{2,4}$';

update public.marketplace_card_versions v
set
  expansion_number = c.card_number,
  expansion_number_int = public.marketplace_expansion_number_int(c.card_number)
from public.marketplace_cards c
where v.card_id = c.card_id
  and c.product_type = 'card'
  and c.card_number ~ '^[0-9]{1,4}[A-Za-z]?/[0-9]{2,4}$'
  and coalesce(v.expansion_number, '') ~ '^[0-9]{4,}$';

update public.marketplace_search_candidates s
set card_number = c.card_number
from public.marketplace_cards c
where s.card_id = c.card_id
  and c.product_type = 'card'
  and c.card_number ~ '^[0-9]{1,4}[A-Za-z]?/[0-9]{2,4}$'
  and coalesce(s.card_number, '') ~ '^[0-9]{4,}$';
