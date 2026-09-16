-- Revert 067. Leftover 130794 is the real Unbroken Bonds 205/214 Full Art:
-- printed Illus. Atsuko Nishida, collector 205/214, same pose as
-- images.pokemontcg.io/sm10/205. Arita's regular is 130/214 (different pose,
-- inner yellow art window). Night Unison and CSM2c CLIP siblings are the same
-- Nishida illustration (CN leftover also prints Illus.Atsuko Nishida).
-- 067 compared a homepage thumb to 130 and moved the cluster in error.

begin;
set local statement_timeout = 0;

update public.marketplace_blueprint_artists artist
set
  artist = 'Atsuko Nishida',
  illustrator = 'Atsuko Nishida',
  normalized_artist = 'atsuko nishida',
  source_card_id = case
    when artist.blueprint_id = 130794 then 'sm10-205'
    else '130794'
  end,
  match_reason = case
    when artist.blueprint_id = 130794 then 'local_dataset;set_number;name_checked'
    else 'clip_version_set'
  end,
  raw_metadata = coalesce(artist.raw_metadata, '{}'::jsonb)
    - 'corrected_from'
    - 'reason'
    || jsonb_build_object(
      'reverted_067', true,
      'note', 'Printed Illus. Atsuko Nishida on leftover JPEG; not Arita 130/214.'
    ),
  updated_at = now()
where artist.blueprint_id in (130794, 353699, 246772)
  and artist.normalized_artist = 'mitsuhiro arita';

select public.refresh_marketplace_artist_card_counts() as artist_counts_refreshed;

commit;

select blueprint_id, artist, normalized_artist, source, source_card_id, match_reason
from public.marketplace_blueprint_artists
where blueprint_id in (130794, 353699, 246772);
