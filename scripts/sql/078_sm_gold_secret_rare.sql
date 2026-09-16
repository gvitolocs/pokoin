-- SM gold trainer/energy secrets that CardTrader left as Secret Rare.
-- Official pokemon.com TCG Card Database prints 141/131 Beast Ring and
-- 158/149 Nest Ball as "Rare Holo" and the press checklists omit secrets.
-- Coded Yellow gold gallery + PsyPokes "(Gold)" + TPCi pull-rate ★S
-- "rare Secret - Trainer/Energy (Gold)" are the same leftover template as
-- Lost Thunder Electropower (already Gold Secret Rare | 232/214, bleed).
-- Stamp leftover bleed. Do not re-run artwork-layout classify: Fighting
-- Energy 169/145 trips gold_rules. Mega X 108/106 stays window.
-- Forbidden Light JP 100–102/094 FA supporters are not gold. Do not write
-- the Pi replica.

begin;
set local statement_timeout = 0;

create temp table sm_gold_secret_ct (ct_id bigint primary key);
insert into sm_gold_secret_ct (ct_id) values
  (119575), (119576), (119577), (119578), (119579), (119580),
  (120570), (120571), (120572), (120573), (120574), (120575),
  (120576), (120577), (120578),
  (128590), (128591), (128592), (128593), (128594), (128595),
  (129861), (129862), (129863), (129864), (129865),
  (130360), (130361), (130362), (130363), (130364), (130365);

update public.marketplace_cards c
set
  card_number = regexp_replace(c.card_number, '^Secret Rare\s*\|', 'Gold Secret Rare |', 'i'),
  projected_at = now()
from sm_gold_secret_ct g
where c.ct_id = g.ct_id
  and c.product_type = 'card'
  and c.card_number ~* '^secret rare \|';

update public.marketplace_card_versions v
set
  expansion_number = c.card_number,
  expansion_number_int = public.marketplace_expansion_number_int(c.card_number)
from public.marketplace_cards c
join sm_gold_secret_ct g on g.ct_id = c.ct_id
where v.card_id = c.card_id
  and v.expansion_number is distinct from c.card_number;

update public.marketplace_search_candidates s
set
  card_number = c.card_number,
  art_layout = 'bleed',
  projected_at = now()
from public.marketplace_cards c
join sm_gold_secret_ct g on g.ct_id = c.ct_id
where s.card_id = c.card_id
  and (
    s.card_number is distinct from c.card_number
    or s.art_layout is distinct from 'bleed'
  );

update public.marketplace_leftover_art_layouts l
set
  layout = 'bleed',
  source = case
    when l.source ~* 'ocr_chrome' then 'catalog_bleed+ocr_chrome'
    else 'catalog_bleed'
  end,
  sampled_at = now()
from sm_gold_secret_ct g
where l.ct_id = g.ct_id
  and (
    l.layout is distinct from 'bleed'
    or l.source !~* '^catalog_bleed'
  );

commit;

select c.ct_id, c.name, c.card_number, c.set_name, l.layout, l.source
from public.marketplace_cards c
join sm_gold_secret_ct g on g.ct_id = c.ct_id
left join public.marketplace_leftover_art_layouts l on l.ct_id = c.ct_id
order by c.set_name, c.card_number;
