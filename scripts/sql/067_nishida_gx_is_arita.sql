-- REVERTED by 069_revert_nishida_gx_arita.sql.
-- Homepage thumbs of 130794 look like Arita 130; the leftover JPEG prints
-- Illus. Atsuko Nishida and 205/214. Do not apply this file.

begin;
set local statement_timeout = 0;

update public.marketplace_blueprint_artists artist
set
  artist = 'Mitsuhiro Arita',
  illustrator = 'Mitsuhiro Arita',
  normalized_artist = 'mitsuhiro arita',
  source_card_id = case
    when artist.blueprint_id = 130794 then 'sm10-130'
    else artist.source_card_id
  end,
  match_reason = case
    when artist.blueprint_id = 130794 then 'regular_gx_photo_not_sm10_205_fa'
    else artist.match_reason
  end,
  raw_metadata = coalesce(artist.raw_metadata, '{}'::jsonb) || jsonb_build_object(
    'corrected_from', 'atsuko nishida',
    'reason', 'Leftover scan is the regular TAG TEAM GX (Arita 130/214 art), not the sm10-205 Full Art.'
  ),
  updated_at = now()
where artist.blueprint_id in (130794, 353699, 246772)
  and artist.normalized_artist = 'atsuko nishida';

select public.refresh_marketplace_artist_card_counts() as artist_counts_refreshed;

commit;

select blueprint_id, artist, normalized_artist, source, source_card_id, match_reason
from public.marketplace_blueprint_artists
where blueprint_id in (130794, 353699, 246772);
