-- Search: trigram match on search_text, then the typeahead name-prefix index.
\set n random(1, 70728)
select c.card_id, c.name, c.set_name
  from marketplace_search_candidates c,
       (select left(search_text, 12) as q from marketplace_search_candidates where card_id = 2 * (100000 + :n)) t
 where c.search_text % t.q
 order by similarity(c.search_text, t.q) desc limit 20;
select card_id, name, set_name
  from marketplace_search_candidates
 where name_prefix = (select name_prefix from marketplace_search_candidates where card_id = 2 * (100000 + :n))
 order by search_weight desc, imported_at desc nulls last limit 20;
