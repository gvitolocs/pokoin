-- Platinum Arceus shiny secrets: CardTrader stored "SH10 | Holo Rare"
-- (collector on the left) and bare SH11/SH12. AR1–AR9 are already
-- "Holo Rare | AR1". Printed codes are SH10–SH12, not n/111.
-- Official checklist: 1/99–99/99 then AR1–AR9 then SH10–SH12.

set statement_timeout = 0;

update public.marketplace_cards
set card_number = 'Holo Rare | ' || regexp_replace(card_number, '\s*\|\s*Holo Rare\s*$', '', 'i')
where set_name = 'Platinum Arceus'
  and product_type = 'card'
  and card_number ~* '^SH[0-9]+[[:space:]]*\|[[:space:]]*Holo Rare$';

update public.marketplace_cards
set card_number = 'Holo Rare | ' || card_number
where set_name = 'Platinum Arceus'
  and product_type = 'card'
  and card_number ~ '^SH[0-9]+$'
  and card_number not like '%|%';

update public.marketplace_card_versions v
set
  expansion_number = c.card_number,
  expansion_number_int = public.marketplace_expansion_number_int(c.card_number)
from public.marketplace_cards c
where v.card_id = c.card_id
  and c.set_name = 'Platinum Arceus'
  and c.product_type = 'card'
  and v.expansion_number is distinct from c.card_number;
