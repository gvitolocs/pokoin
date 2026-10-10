-- 097: Andrea Paolo Ciliberti is Pokoin's Founder Ambassador — the first
-- ambassador, a one-off title. Role `founder_ambassador` progresses like any
-- ambassador (pokoin-rust/crates/accounts/src/domain/ambassador.rs) and gets the founder
-- welcome on /associate (market/src/pages/Associate.jsx).
--
-- Apply on the nezopt writer:
--   docker exec -i pokoin-marketplace-postgres-15t psql -U pokoin_marketplace \
--     -d pokoin_marketplace -v ON_ERROR_STOP=1 < scripts/sql/097_founder_ambassador.sql

update public.marketplace_associates
   set role = 'founder_ambassador',
       display_name = 'Andrea Paolo',
       updated_at = now()
 where email = 'apciliberti@gmail.com';
