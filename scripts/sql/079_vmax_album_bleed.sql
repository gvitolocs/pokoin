-- VMAX leftovers are only full artwork. Giuseppe 2026-09-14: album bleed,
-- not a framed illustration window. Prize-pack Vaporeon VMAX 030/203
-- included. Do not re-run artwork-layout classify: catalog_gx used to
-- stamp Ultra Rare / bare n/m VMAX as window. Holo Rare Mega EX stays
-- window. Do not write the Pi replica.

begin;
set local statement_timeout = 0;

create temp table vmax_ct (ct_id bigint primary key);
insert into vmax_ct (ct_id)
select c.ct_id
from public.marketplace_cards c
where c.product_type = 'card'
  and c.name ~* '\yvmax\y';

update public.marketplace_leftover_art_layouts l
set
  layout = 'bleed',
  source = 'catalog_bleed',
  sampled_at = now()
from vmax_ct v
where l.ct_id = v.ct_id
  and l.layout is distinct from 'bleed';

insert into public.marketplace_leftover_art_layouts (ct_id, layout, source, sampled_at)
select v.ct_id, 'bleed', 'catalog_bleed', now()
from vmax_ct v
where not exists (
  select 1
  from public.marketplace_leftover_art_layouts l
  where l.ct_id = v.ct_id
);

update public.marketplace_search_candidates s
set
  art_layout = 'bleed',
  projected_at = now()
from public.marketplace_cards c
join vmax_ct v on v.ct_id = c.ct_id
where s.card_id = c.card_id
  and s.art_layout is distinct from 'bleed';

commit;

select
  count(*) filter (where l.layout = 'bleed') as leftover_bleed,
  count(*) filter (where l.layout is distinct from 'bleed') as leftover_other,
  (select count(*) from vmax_ct) as vmax_cards
from vmax_ct v
left join public.marketplace_leftover_art_layouts l on l.ct_id = v.ct_id;
