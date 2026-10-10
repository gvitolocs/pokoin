-- Stored position of every catalog row inside its expansion (`set_order`),
-- so the card desk arrows and set lists read an index instead of parsing
-- collector numbers on every request.
--
-- Order: natural sort of the printed collector number (the part after
-- "Rarity | "), digits compared as numbers and digit-led numbers before
-- letter-led ones: 1/95 .. 95/95, SL1 .. SL11; OP14-039 < OP14-039a < OP14-040;
-- Magic "T 29/19" tokens after the main set. Empty numbers go last.
-- Ties: collector text, name, card_id.
--
-- Apply to every game database. `marketplace_refresh_set_order()` is called by
-- the build-lists job (every 15 minutes) and only rewrites rows that moved.

alter table public.marketplace_search_candidates
  add column if not exists set_order integer not null default 0;

create index concurrently if not exists marketplace_search_candidates_set_order_idx
  on public.marketplace_search_candidates (set_name, set_order);

create or replace function public.marketplace_collector_natural_key(card_number text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when s.num = '' then '2'
    else coalesce((
      select string_agg(
        case when m[1] ~ '^[0-9]' then '0' || lpad(m[1], 12, '0') else '1' || lower(m[1]) end,
        '' order by t.ord)
      from regexp_matches(s.num, '([0-9]+|[^0-9]+)', 'g') with ordinality as t(m, ord)
    ), '2')
  end
  from (select btrim(regexp_replace(coalesce(card_number, ''), '^.*\|\s*', '')) as num) s
$$;

create or replace function public.marketplace_refresh_set_order(p_set text default null)
returns integer
language plpgsql
set search_path = public
as $$
declare
  changed integer := 0;
begin
  with ranked as (
    select
      card_id,
      row_number() over (
        partition by set_name
        order by public.marketplace_collector_natural_key(card_number::text) collate "C",
                 coalesce(card_number::text, ''), coalesce(name, ''), card_id
      )::integer as pos
    from public.marketplace_search_candidates
    where coalesce(set_name, '') <> ''
      and (p_set is null or set_name = p_set)
  )
  update public.marketplace_search_candidates c
  set set_order = r.pos
  from ranked r
  where c.card_id = r.card_id
    and c.set_order is distinct from r.pos;
  get diagnostics changed = row_count;
  return changed;
end;
$$;
