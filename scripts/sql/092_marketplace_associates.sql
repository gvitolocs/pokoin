-- Pokoin Associates program.
--
-- Role-scoped revenue-share partners (distributor, ambassador, …). Each row
-- carries the deal terms the /associate desk renders and the API enforces:
--   royalty_pct — the platform checkout commission the pool is taken from
--                 (mirrors market/src/checkout-fees.js CHECKOUT_COMMISSION_RATE)
--   share_pct   — the associate's cut of that royalty pool
--   window_*    — the campaign the promise covers
--
-- Apply on the nezopt NVMe writer (MARKETPLACE_WRITER_DATABASE_URL), then the
-- Pi replica picks it up on its next sync. Never archive this table's history.

create table if not exists public.marketplace_associates (
  email         text primary key,
  role          text not null default 'associate',
  display_name  text not null default '',
  share_pct     numeric not null default 100 check (share_pct >= 0 and share_pct <= 100),
  royalty_pct   numeric not null default 3 check (royalty_pct >= 0 and royalty_pct <= 100),
  window_start  timestamptz not null default date_trunc('day', now()),
  window_end    timestamptz not null,
  active        boolean not null default true,
  firebase_uid  text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Gianlonji (distributor): 100% of all checkout royalties on sales made by
-- Italian sellers to Italian buyers, from launch through the end of October.
insert into public.marketplace_associates
  (email, role, display_name, share_pct, royalty_pct, window_start, window_end, active)
values
  ('gianlonji@gmail.com',   'distributor', 'Gianlonji',  100, 3, '2026-09-29T00:00:00Z', '2026-10-31T23:59:59Z', true),
  ('apciliberti@gmail.com', 'ambassador',  'Apciliberti', 100, 3, '2026-09-29T00:00:00Z', '2026-10-31T23:59:59Z', true)
on conflict (email) do update set
  role         = excluded.role,
  display_name = excluded.display_name,
  share_pct    = excluded.share_pct,
  royalty_pct  = excluded.royalty_pct,
  window_start = excluded.window_start,
  window_end   = excluded.window_end,
  active       = excluded.active,
  updated_at   = now();
