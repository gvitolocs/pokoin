-- Set page: every printing of one expansion, ranked.
\set n random(1, 70728)
select card_id, name, card_number, rarity
  from marketplace_search_candidates
 where expansion_name = (select expansion_name from marketplace_search_candidates where card_id = 2 * (100000 + :n))
 order by search_weight desc limit 300;
