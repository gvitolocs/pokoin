-- Japanese (and a few SM-P) Tag Team GX titles include the mechanic words
-- CardTrader left off western Cosmic Eclipse names:
--   Mega Lopunny & Jigglypuff Tag Team GX  →  Mega Lopunny & Jigglypuff GX
-- Also the missing-space SM-P titles (Lucario & MelmetalTag Team GX).
-- Sleeves / boxes keep "Tag Team GX" because they do not end with those words
-- as the card name, and product_type is not card.
-- Projection copies blueprint.name; the trigger restamps so dumps cannot revert.

set statement_timeout = 0;

create or replace function public.marketplace_sanitize_card_name(name text)
returns text
language plpgsql
immutable
as $$
declare
  cleaned text := trim(both from coalesce(name, ''));
begin
  cleaned := regexp_replace(cleaned, '\s*Tag Team GX\s*$', ' GX', 'i');
  cleaned := regexp_replace(cleaned, '\s+', ' ', 'g');
  return trim(both from cleaned);
end;
$$;

create or replace function public.marketplace_cards_sanitize_tag_team_name()
returns trigger
language plpgsql
as $$
begin
  if new.product_type is distinct from 'card' then
    return new;
  end if;
  new.name := public.marketplace_sanitize_card_name(new.name);
  return new;
end;
$$;

drop trigger if exists marketplace_cards_sanitize_tag_team_name on public.marketplace_cards;
create trigger marketplace_cards_sanitize_tag_team_name
before insert or update of name, product_type
on public.marketplace_cards
for each row
execute function public.marketplace_cards_sanitize_tag_team_name();

with renamed as (
  select
    c.card_id,
    c.name as tagged_name,
    public.marketplace_sanitize_card_name(c.name) as clean_name
  from public.marketplace_cards c
  where c.product_type = 'card'
    and c.name is distinct from public.marketplace_sanitize_card_name(c.name)
)
insert into public.marketplace_card_names (name, normalized_name, compact_name, emoji, name_tokens, updated_at)
select distinct
  r.clean_name,
  public.marketplace_search_normalize(r.clean_name),
  public.marketplace_search_compact(r.clean_name),
  public.marketplace_card_name_emoji(r.clean_name),
  public.marketplace_search_tokenize(r.clean_name),
  now()
from renamed r
on conflict (name) do update set
  normalized_name = excluded.normalized_name,
  compact_name = excluded.compact_name,
  emoji = excluded.emoji,
  name_tokens = excluded.name_tokens,
  updated_at = now();

insert into public.marketplace_card_nicknames (
  nickname, normalized_nickname, compact_nickname, card_name, source, updated_at
)
select distinct
  r.tagged_name,
  public.marketplace_search_normalize(r.tagged_name),
  public.marketplace_search_compact(r.tagged_name),
  r.clean_name,
  'tag_team_gx',
  now()
from (
  select
    c.name as tagged_name,
    public.marketplace_sanitize_card_name(c.name) as clean_name
  from public.marketplace_cards c
  where c.product_type = 'card'
    and c.name is distinct from public.marketplace_sanitize_card_name(c.name)
) r
on conflict (normalized_nickname, card_name, expansion_name, card_number) do update set
  nickname = excluded.nickname,
  compact_nickname = excluded.compact_nickname,
  source = excluded.source,
  updated_at = now();

insert into public.marketplace_card_nickname_hits (card_id, nickname, updated_at)
select c.card_id, c.name, now()
from public.marketplace_cards c
where c.product_type = 'card'
  and c.name is distinct from public.marketplace_sanitize_card_name(c.name)
on conflict (card_id, nickname) do update set updated_at = now();

update public.card_name_languages l
set name = public.marketplace_sanitize_card_name(l.name)
where l.name is distinct from public.marketplace_sanitize_card_name(l.name)
  and not exists (
    select 1
    from public.card_name_languages other
    where other.name = public.marketplace_sanitize_card_name(l.name)
      and other.language = l.language
  );

delete from public.card_name_languages l
where l.name is distinct from public.marketplace_sanitize_card_name(l.name);

update public.marketplace_cards
set
  name = public.marketplace_sanitize_card_name(name),
  projected_at = now()
where product_type = 'card'
  and name is distinct from public.marketplace_sanitize_card_name(name);

update public.marketplace_search_candidates s
set
  name = c.name,
  source_name = case
    when s.source_name is not distinct from s.name then c.name
    else public.marketplace_sanitize_card_name(s.source_name)
  end,
  display_name = case
    when s.display_name is not distinct from s.name then c.name
    else public.marketplace_sanitize_card_name(s.display_name)
  end,
  canonical_name = case
    when s.canonical_name is not distinct from s.name then c.name
    else public.marketplace_sanitize_card_name(s.canonical_name)
  end
from public.marketplace_cards c
where s.card_id = c.card_id
  and c.product_type = 'card'
  and (
    s.name is distinct from c.name
    or s.source_name is distinct from public.marketplace_sanitize_card_name(s.source_name)
    or s.display_name is distinct from public.marketplace_sanitize_card_name(s.display_name)
    or s.canonical_name is distinct from public.marketplace_sanitize_card_name(s.canonical_name)
  );

-- Meili delta keys off candidates.projected_at, not marketplace_cards.
update public.marketplace_search_candidates s
set projected_at = c.projected_at
from public.marketplace_cards c
where s.card_id = c.card_id
  and c.product_type = 'card'
  and s.name = c.name
  and s.projected_at is distinct from c.projected_at
  and c.projected_at >= now() - interval '1 hour';

update public.marketplace_card_versions v
set
  name = public.marketplace_sanitize_card_name(v.name),
  source_name = public.marketplace_sanitize_card_name(v.source_name),
  display_name = public.marketplace_sanitize_card_name(v.display_name),
  canonical_name = public.marketplace_sanitize_card_name(v.canonical_name)
where v.name is distinct from public.marketplace_sanitize_card_name(v.name)
   or v.source_name is distinct from public.marketplace_sanitize_card_name(v.source_name)
   or v.display_name is distinct from public.marketplace_sanitize_card_name(v.display_name)
   or v.canonical_name is distinct from public.marketplace_sanitize_card_name(v.canonical_name);

select
  count(*) filter (where name ~* 'tag team gx$')::integer as leftover_tag_team_cards
from public.marketplace_cards
where product_type = 'card';
