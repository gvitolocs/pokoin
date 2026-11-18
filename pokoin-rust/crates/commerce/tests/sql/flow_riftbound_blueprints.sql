-- The satellite blueprint the Riftbound listing of
-- tests/listing_ct_facets_flow.rs maps its facets onto: CardTrader's product
-- takes condition, English only, and the foil flag (`blueprint_properties_sql`
-- reads `editable_properties` from the game's own schema). The listing's
-- `card_id` is twice the blueprint: `push::blueprint` halves an even id.
-- Drop and recreate: a throwaway database only.
create schema if not exists marketplace_riftbound;
drop table if exists marketplace_riftbound.cardtrader_blueprints cascade;
create table marketplace_riftbound.cardtrader_blueprints (
  id bigint primary key,
  editable_properties jsonb not null default '[]'::jsonb
);
insert into marketplace_riftbound.cardtrader_blueprints (id, editable_properties) values
  (110481, '[
    {"name": "condition", "type": "string", "possible_values": ["Near Mint", "Slightly Played"]},
    {"name": "riftbound_language", "type": "string", "possible_values": ["en"]},
    {"name": "riftbound_foil", "type": "boolean"}
  ]'::jsonb);
