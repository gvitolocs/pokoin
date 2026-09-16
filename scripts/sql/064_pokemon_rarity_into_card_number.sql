-- CardTrader keeps printed rarity on fixed_properties.pokemon_rarity
-- ("Rare") and often leaves blueprint.version as bare n/m ("119/214").
-- Holo / Ultra / Illustration rares already have the rarity in `version`
-- ("Illustration Rare | 087/080"). Prefix the CT rarity onto bare n/m
-- so the desk badge is "Rare 119/214", not a guessed Illustration Rare.
-- Do not prefix Common / Uncommon / Fixed / Promo — those stay collector-only.
-- Do not put a generic "rare" token in the URL slug (Rare Candy).

set statement_timeout = 0;

create or replace function public.marketplace_printed_card_number(card_number text, pokemon_rarity text)
returns text
language plpgsql
immutable
as $$
declare
  number text := trim(both from coalesce(card_number, ''));
  rarity text := trim(both from coalesce(pokemon_rarity, ''));
begin
  if number like '%|%' then
    return number;
  end if;
  if number !~ '^[0-9]{1,4}[A-Za-z]?/[0-9]{2,4}$' then
    return number;
  end if;
  if rarity = '' or rarity ~* '^(card|cards|common|uncommon|fixed|promo|no rarity|oversized|unknown|pokemon|pokémon|product|singles?)$' then
    return number;
  end if;
  return rarity || ' | ' || number;
end;
$$;

create or replace function public.marketplace_cards_resolve_printed_rarity()
returns trigger
language plpgsql
as $$
declare
  ct_rarity text;
begin
  if new.product_type is distinct from 'card' then
    return new;
  end if;
  select b.blueprint#>>'{fixed_properties,pokemon_rarity}'
    into ct_rarity
  from public.pokoin_pokemon_blueprints b
  where b.id = new.ct_id;
  new.card_number := public.marketplace_printed_card_number(new.card_number, ct_rarity);
  return new;
end;
$$;

drop trigger if exists marketplace_cards_resolve_printed_rarity on public.marketplace_cards;
create trigger marketplace_cards_resolve_printed_rarity
before insert or update of card_number, ct_id, product_type
on public.marketplace_cards
for each row
execute function public.marketplace_cards_resolve_printed_rarity();

update public.marketplace_cards c
set card_number = public.marketplace_printed_card_number(
  c.card_number,
  b.blueprint#>>'{fixed_properties,pokemon_rarity}'
)
from public.pokoin_pokemon_blueprints b
where b.id = c.ct_id
  and c.product_type = 'card'
  and public.marketplace_printed_card_number(
    c.card_number,
    b.blueprint#>>'{fixed_properties,pokemon_rarity}'
  ) is distinct from c.card_number;

update public.marketplace_card_versions v
set
  expansion_number = c.card_number,
  expansion_number_int = public.marketplace_expansion_number_int(c.card_number)
from public.marketplace_cards c
where v.card_id = c.card_id
  and c.product_type = 'card'
  and v.expansion_number is distinct from c.card_number;

update public.marketplace_search_candidates s
set card_number = c.card_number
from public.marketplace_cards c
where s.card_id = c.card_id
  and c.product_type = 'card'
  and s.card_number is distinct from c.card_number;
