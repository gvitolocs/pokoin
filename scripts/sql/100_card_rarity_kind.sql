-- Specific rarity type on the card, separate from the printed rarity line
-- and from the page URL. Empty means an ordinary card: the desk keeps the
-- artwork delta. rainbow / gold / ghost are the only special types.
-- Ghost is the Yu-Gi-Oh Ghost Rare, not a Pokémon ghost emoji.

set statement_timeout = 0;

create or replace function public.marketplace_rarity_kind(rarity text, card_number text)
returns text
language sql
immutable
as $$
  select case
    when blob ~ 'rainbow|hyper[[:space:]]+rare' then 'rainbow'
    when blob ~ '\mgold\M' then 'gold'
    when blob ~ 'ghost[[:space:]]+rare' then 'ghost'
    else ''
  end
  from (
    select lower(trim(both from concat_ws(' ', coalesce(rarity, ''), coalesce(card_number, '')))) as blob
  ) s
$$;

alter table public.marketplace_cards
  add column if not exists rarity_kind text not null default '';

alter table public.marketplace_search_candidates
  add column if not exists rarity_kind text not null default '';

alter table public.marketplace_cards
  drop constraint if exists marketplace_cards_rarity_kind_check;
alter table public.marketplace_cards
  add constraint marketplace_cards_rarity_kind_check
  check (rarity_kind in ('', 'rainbow', 'gold', 'ghost'));

alter table public.marketplace_search_candidates
  drop constraint if exists marketplace_search_candidates_rarity_kind_check;
alter table public.marketplace_search_candidates
  add constraint marketplace_search_candidates_rarity_kind_check
  check (rarity_kind in ('', 'rainbow', 'gold', 'ghost'));

create or replace function public.marketplace_cards_set_rarity_kind()
returns trigger
language plpgsql
as $$
begin
  new.rarity_kind := public.marketplace_rarity_kind(new.rarity, new.card_number);
  return new;
end;
$$;

drop trigger if exists marketplace_cards_set_rarity_kind on public.marketplace_cards;
create trigger marketplace_cards_set_rarity_kind
before insert or update of rarity, card_number
on public.marketplace_cards
for each row
execute function public.marketplace_cards_set_rarity_kind();

drop trigger if exists marketplace_search_candidates_set_rarity_kind
  on public.marketplace_search_candidates;
create trigger marketplace_search_candidates_set_rarity_kind
before insert or update of rarity, card_number
on public.marketplace_search_candidates
for each row
execute function public.marketplace_cards_set_rarity_kind();

update public.marketplace_cards
set rarity_kind = public.marketplace_rarity_kind(rarity, card_number)
where rarity_kind is distinct from public.marketplace_rarity_kind(rarity, card_number);

update public.marketplace_search_candidates
set rarity_kind = public.marketplace_rarity_kind(rarity, card_number)
where rarity_kind is distinct from public.marketplace_rarity_kind(rarity, card_number);
