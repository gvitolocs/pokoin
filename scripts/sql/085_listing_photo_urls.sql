alter table public.marketplace_user_listings
  add column if not exists photo_urls text[] not null default '{}';
