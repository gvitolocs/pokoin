-- Connected CardTrader listings are an exact inventory mirror, not a second
-- source of sold-price evidence. The global CardTrader sold-comps pipeline
-- already owns those sales. Reclassify linked mirror updates and rebuild the
-- native sold counters from genuine Pokoin listing events only.
--
-- Idempotent. Apply on the nezopt NVMe writer; the Pi replica follows.

begin;

create or replace function public.marketplace_user_listings_audit()
returns trigger
language plpgsql
as $$
declare
  ev text;
  card text;
  q_before integer;
  q_after integer;
  sold_qty integer := 0;
  is_new boolean := false;
  is_sold boolean := false;
  is_removed boolean := false;
  is_cardtrader_link boolean := false;
begin
  if tg_op = 'INSERT' then
    is_cardtrader_link := lower(coalesce(new.source_listing_id, '')) like 'ct:%';
    card := new.card_id;
    ev := 'listed';
    q_before := 0;
    q_after := coalesce(new.quantity_available, 0);
    is_new := true;
  elsif tg_op = 'DELETE' then
    is_cardtrader_link := lower(coalesce(old.source_listing_id, '')) like 'ct:%';
    card := old.card_id;
    q_before := coalesce(old.quantity_available, 0);
    q_after := 0;
    if lower(coalesce(old.status, '')) in ('sold_out', 'sold') or q_before > 0 then
      ev := 'sold';
      sold_qty := q_before;
      is_sold := true;
    else
      ev := 'removed';
      is_removed := true;
    end if;
  else
    is_cardtrader_link := lower(coalesce(new.source_listing_id, old.source_listing_id, '')) like 'ct:%';
    card := coalesce(new.card_id, old.card_id);
    q_before := coalesce(old.quantity_available, 0);
    q_after := coalesce(new.quantity_available, 0);
    if q_after < q_before then
      sold_qty := q_before - q_after;
      is_sold := true;
      ev := case
        when q_after = 0 or lower(coalesce(new.status, '')) in ('sold_out', 'sold')
        then 'sold'
        else 'quantity_decreased'
      end;
    elsif lower(coalesce(new.status, '')) in ('sold_out', 'sold')
      and lower(coalesce(old.status, '')) not in ('sold_out', 'sold') then
      ev := 'sold';
      sold_qty := greatest(q_before, 1);
      is_sold := true;
    elsif lower(coalesce(new.status, '')) in ('paused', 'cancelled', 'removed', 'inactive')
      and lower(coalesce(old.status, '')) = 'active' then
      ev := 'removed';
      is_removed := true;
    else
      ev := 'updated';
    end if;
  end if;

  if is_cardtrader_link and is_sold then
    ev := 'cardtrader_synced';
    sold_qty := 0;
    is_sold := false;
  end if;

  if card is null or card = '' then
    return coalesce(new, old);
  end if;

  insert into public.marketplace_user_listing_events (
    listing_id,
    card_id,
    seller_uid,
    event_type,
    quantity_before,
    quantity_after,
    status_before,
    status_after,
    price_pkn,
    occurred_at
  )
  values (
    coalesce(new.id, old.id),
    card,
    coalesce(new.seller_uid, old.seller_uid, ''),
    ev,
    q_before,
    q_after,
    case when tg_op = 'INSERT' then null else old.status end,
    case when tg_op = 'DELETE' then old.status else new.status end,
    coalesce(new.price_pkn, old.price_pkn),
    now()
  );

  insert into public.marketplace_listing_stats_daily (
    card_id,
    observed_day,
    source,
    new_listings,
    new_quantity,
    sold_listings,
    sold_quantity,
    refreshed_at
  )
  values (
    card,
    (timezone('utc', now()))::date,
    'native',
    case when is_new then 1 else 0 end,
    case when is_new then q_after else 0 end,
    case when is_sold then 1 else 0 end,
    case when is_sold then sold_qty else 0 end,
    now()
  )
  on conflict (card_id, observed_day, source) do update set
    new_listings = public.marketplace_listing_stats_daily.new_listings + excluded.new_listings,
    new_quantity = public.marketplace_listing_stats_daily.new_quantity + excluded.new_quantity,
    sold_listings = public.marketplace_listing_stats_daily.sold_listings + excluded.sold_listings,
    sold_quantity = public.marketplace_listing_stats_daily.sold_quantity + excluded.sold_quantity,
    refreshed_at = now();

  if is_removed then
    null;
  end if;

  return coalesce(new, old);
end;
$$;

-- Preserve the audit trail while removing the false native-sale meaning.
update public.marketplace_user_listing_events event
set event_type = 'cardtrader_synced'
where event.event_type in ('sold', 'quantity_decreased')
  and (
    exists (
      select 1
      from public.marketplace_user_listings listing
      where listing.id = event.listing_id
        and lower(coalesce(listing.source_listing_id, '')) like 'ct:%'
    )
    or exists (
      select 1
      from public.marketplace_cardtrader_product_links link
      where link.listing_id = event.listing_id
    )
  );

-- Rebuild the sold columns rather than subtracting deltas. This is safe on
-- repeated runs and retains real Pokoin sold/quantity-decreased events.
update public.marketplace_listing_stats_daily
set
  sold_listings = 0,
  sold_quantity = 0,
  refreshed_at = now()
where source = 'native'
  and (sold_listings <> 0 or sold_quantity <> 0);

insert into public.marketplace_listing_stats_daily (
  card_id,
  observed_day,
  source,
  sold_listings,
  sold_quantity,
  refreshed_at
)
select
  event.card_id,
  (timezone('utc', event.occurred_at))::date,
  'native',
  count(*)::integer,
  coalesce(sum(
    case
      when coalesce(event.quantity_after, 0) < coalesce(event.quantity_before, 0)
        then event.quantity_before - event.quantity_after
      else greatest(coalesce(event.quantity_before, 0), 1)
    end
  ), 0)::integer,
  now()
from public.marketplace_user_listing_events event
where event.event_type in ('sold', 'quantity_decreased')
group by event.card_id, (timezone('utc', event.occurred_at))::date
on conflict (card_id, observed_day, source) do update set
  sold_listings = excluded.sold_listings,
  sold_quantity = excluded.sold_quantity,
  refreshed_at = now();

commit;

-- The stats are now source-correct; refresh weights after committing the
-- trigger/history repair so readers never see CT mirror sales as native.
select public.refresh_marketplace_card_weights();
