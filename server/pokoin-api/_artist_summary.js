'use strict';

const READ_SQL = `
select
  normalized_artist,
  artist,
  illustrator,
  artist_slug,
  artist_card_count,
  visible_card_count,
  profile_display_name,
  profile_image_url,
  image_url,
  cover_name,
  art_shade
from public.marketplace_artist_summary
order by artist_card_count desc, artist asc, artist_slug asc
limit $1
`;

function summaryRow(row) {
  return {
    artist: row.artist || row.illustrator || '',
    illustrator: row.illustrator || '',
    slug: row.artist_slug || '',
    cardCount: Number(row.artist_card_count || 0),
    visibleCardCount: Number(row.visible_card_count || 0),
    displayName: row.profile_display_name || row.artist || '',
    profileImageUrl: row.profile_image_url || '',
    imageUrl: row.image_url || '',
    coverName: row.cover_name || '',
    artShade: row.art_shade || '',
  };
}

async function readArtistSummary(query, limit) {
  try {
    const result = await query(READ_SQL, [limit]);
    if (!result?.rows?.length) return null;
    return result.rows;
  } catch (error) {
    if (error.code === '42P01') return null;
    throw error;
  }
}

module.exports = {
  READ_SQL,
  readArtistSummary,
  summaryRow,
};
