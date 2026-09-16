-- Sword & Shield Amazing Rare leftovers are half-art: illustration box
-- above the attack sheet. CardTrader named most of them Illustration Rare,
-- so catalog_bleed painted a two-row leftover (HP + Amazing Shot) on the
-- artist album. CLIP holos of the same painting (CS2b / 30th) stay window.
-- Do not write the Pi replica.

begin;
set local statement_timeout = 0;

alter table public.marketplace_leftover_art_layouts
  drop constraint if exists marketplace_leftover_art_layouts_layout;
alter table public.marketplace_leftover_art_layouts
  add constraint marketplace_leftover_art_layouts_layout
  check (layout in ('window', 'bleed', 'landscape', 'halfart'));

create temp table amazing_rare_ct (ct_id bigint primary key);
insert into amazing_rare_ct (ct_id) values
  -- Vivid Voltage
  (150243), (150314), (150378), (150415), (150446), (150481),
  -- Shining Fates
  (152972), (152975), (153000),
  -- Legendary Heartbeat
  (224723), (224730), (224748), (224766), (224781), (224794),
  -- Shiny Star V
  (224974), (224989), (225126);

update public.marketplace_cards c
set
  card_number = case
    when c.card_number ~* 'amazing rare' then c.card_number
    when c.card_number ~ '\|' then regexp_replace(c.card_number, '^[^|]+\|', 'Amazing Rare |')
    else 'Amazing Rare | ' || btrim(c.card_number)
  end,
  projected_at = now()
from amazing_rare_ct g
where c.ct_id = g.ct_id
  and c.product_type = 'card';

update public.marketplace_card_versions v
set
  expansion_number = c.card_number,
  expansion_number_int = public.marketplace_expansion_number_int(c.card_number)
from public.marketplace_cards c
join amazing_rare_ct g on g.ct_id = c.ct_id
where v.card_id = c.card_id
  and v.expansion_number is distinct from c.card_number;

update public.marketplace_search_candidates s
set
  card_number = c.card_number,
  art_layout = 'halfart',
  projected_at = now()
from public.marketplace_cards c
join amazing_rare_ct g on g.ct_id = c.ct_id
where s.card_id = c.card_id
  and (
    s.card_number is distinct from c.card_number
    or s.art_layout is distinct from 'halfart'
  );

insert into public.marketplace_leftover_art_layouts (ct_id, layout, source, version, sampled_at)
select
  c.ct_id,
  'halfart',
  'catalog_amazing',
  coalesce(s.version, ''),
  now()
from public.marketplace_cards c
join amazing_rare_ct g on g.ct_id = c.ct_id
left join public.marketplace_search_candidates s on s.card_id = c.card_id
on conflict (ct_id) do update
  set layout = 'halfart',
      source = 'catalog_amazing',
      version = excluded.version,
      sampled_at = now();

commit;

select c.ct_id, c.name, c.card_number, s.set_name, l.layout, l.source
from public.marketplace_cards c
join amazing_rare_ct g on g.ct_id = c.ct_id
left join public.marketplace_search_candidates s on s.card_id = c.card_id
left join public.marketplace_leftover_art_layouts l on l.ct_id = c.ct_id
order by s.set_name, c.card_number;
