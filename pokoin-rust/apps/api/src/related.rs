//! Related cards: a precomputed nearest-neighbour index.
//!
//! `pokoin-api job build-lists --kind=related` scores every single against the
//! cards it could plausibly sit next to and stores the best 12 as ready tile
//! rows (`marketplace_page_snapshots`, kind `related`, key = public card id),
//! in JSON and `c1`. `/api/marketplace-card-page` adds them as `related` and
//! `/api/marketplace-related?cardId=` serves them alone; both are one
//! primary-key read. `--kind=related-delta` rewrites only the cards whose own
//! row, price or neighbours changed since the last build.
//!
//! The score starts from the SPA's `scoreRelated` (market/src/seo.js) and adds
//! the catalogue facts the browser never had for the whole catalogue.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};
use sqlx::PgPool;

use pokoin_api_common::compact;
use pokoin_catalog_api::shared::{js, page_snapshot, react_card, react_sql};

/// Desk "Related cards" shows at most 12 tiles (Codevira D00005F).
pub const RELATED_MAX: usize = 12;

// scoreRelated (market/src/seo.js), unchanged.
const SAME_DEX: f32 = 8.0;
const SAME_SET: f32 = 5.0;
const SAME_NAME: f32 = 4.0;
const SAME_ARTIST: f32 = 3.0;
const SAME_RARITY: f32 = 2.0;
// Server-side additions.
/// Same CLIP same-artwork cluster (`pokoin_version_sets.version`).
const SAME_ARTWORK: f32 = 6.0;
/// Evolution line, approximated by adjacent National Pokédex numbers (the
/// catalogue has no evolution table): ±1 and ±2.
const DEX_STEP_1: f32 = 3.0;
const DEX_STEP_2: f32 = 1.5;
/// Same TCG era (`expansion_sort / ERA_SPAN`).
const SAME_ERA: f32 = 1.5;
/// Release proximity inside `RELEASE_WINDOW` of `expansion_sort`, linear.
const RELEASE_NEAR: f32 = 1.5;
/// Same title language (the expansion's print nationality).
const SAME_LANGUAGE: f32 = 1.5;
// Tie-breaks: smaller than any real feature.
const LISTED: f32 = 0.5;
const POPULAR: f32 = 0.4;

const ERA_SPAN: i32 = 5_000;
const RELEASE_WINDOW: f32 = 10_000.0;
/// A generator bucket larger than this (a prolific artist) proposes nobody;
/// its feature still scores candidates proposed by the other buckets.
const BUCKET_CAP: usize = 1_500;

#[derive(Debug, Clone, Default)]
pub struct Card {
    pub id: i64,
    pub name: String,
    pub set: String,
    pub rarity: String,
    pub artist: String,
    pub version: String,
    pub dex: i32,
    pub sort: i32,
    pub language: String,
    pub listed: bool,
    /// 0..=1.
    pub popularity: f32,
}

pub fn score(a: &Card, b: &Card) -> f32 {
    if a.id == b.id {
        return 0.0;
    }
    let mut s = 0.0;
    if a.dex > 0 && b.dex > 0 {
        s += match (a.dex - b.dex).abs() {
            0 => SAME_DEX,
            1 => DEX_STEP_1,
            2 => DEX_STEP_2,
            _ => 0.0,
        };
    }
    if !a.set.is_empty() && a.set == b.set {
        s += SAME_SET;
    }
    if !a.name.is_empty() && a.name == b.name {
        s += SAME_NAME;
    }
    if !a.artist.is_empty() && a.artist == b.artist {
        s += SAME_ARTIST;
    }
    if !a.rarity.is_empty() && a.rarity == b.rarity {
        s += SAME_RARITY;
    }
    if !a.version.is_empty() && a.version == b.version {
        s += SAME_ARTWORK;
    }
    if a.sort > 0 && b.sort > 0 {
        if a.sort / ERA_SPAN == b.sort / ERA_SPAN {
            s += SAME_ERA;
        }
        s += RELEASE_NEAR * (1.0 - (a.sort - b.sort).abs() as f32 / RELEASE_WINDOW).max(0.0);
    }
    if !a.language.is_empty() && a.language == b.language {
        s += SAME_LANGUAGE;
    }
    if s <= 0.0 {
        return 0.0;
    }
    s + if b.listed { LISTED } else { 0.0 } + POPULAR * b.popularity
}

fn buckets<K: std::hash::Hash + Eq>(cards: &[Card], key: impl Fn(&Card) -> Option<K>) -> HashMap<K, Vec<u32>> {
    let mut map: HashMap<K, Vec<u32>> = HashMap::new();
    for (i, card) in cards.iter().enumerate() {
        if let Some(k) = key(card) {
            map.entry(k).or_default().push(i as u32);
        }
    }
    map
}

/// The best [`RELATED_MAX`] neighbours of every card, best first, as indexes
/// into `cards`.
pub fn neighbours(cards: &[Card]) -> Vec<Vec<u32>> {
    let text = |s: &str| (!s.is_empty()).then(|| s.to_owned());
    let by_version = buckets(cards, |c| text(&c.version));
    let by_name = buckets(cards, |c| text(&c.name));
    let by_set = buckets(cards, |c| text(&c.set));
    let by_artist = buckets(cards, |c| text(&c.artist));
    let by_dex = buckets(cards, |c| (c.dex > 0).then_some(c.dex));
    let mut seen = vec![u32::MAX; cards.len()];
    let mut scored: Vec<(f32, u32)> = Vec::new();
    let mut out = Vec::with_capacity(cards.len());
    for (i, card) in cards.iter().enumerate() {
        scored.clear();
        seen[i] = i as u32;
        let mut propose = |bucket: Option<&Vec<u32>>| {
            for &j in bucket.filter(|b| b.len() <= BUCKET_CAP).into_iter().flatten() {
                if seen[j as usize] != i as u32 {
                    seen[j as usize] = i as u32;
                    let s = score(card, &cards[j as usize]);
                    if s > 0.0 {
                        scored.push((s, j));
                    }
                }
            }
        };
        propose(by_version.get(&card.version));
        propose(by_name.get(&card.name));
        propose(by_set.get(&card.set));
        propose(by_artist.get(&card.artist));
        if card.dex > 0 {
            for dex in card.dex - 2..=card.dex + 2 {
                propose(by_dex.get(&dex));
            }
        }
        // Total order: score, then the lower public id (stable across builds).
        scored.sort_unstable_by(|a, b| b.0.total_cmp(&a.0).then_with(|| cards[a.1 as usize].id.cmp(&cards[b.1 as usize].id)));
        out.push(scored.iter().take(RELATED_MAX).map(|(_, j)| *j).collect());
    }
    out
}

type FeatureRow = (i64, String, String, String, String, String, Option<i32>, Option<i32>, f64, String);

/// Every single with an image, with the features [`score`] reads.
pub async fn load_cards(pool: &PgPool) -> anyhow::Result<Vec<Card>> {
    let rows: Vec<FeatureRow> = sqlx::query_as(
        "select c.card_id, lower(trim(coalesce(c.name, ''))), coalesce(c.set_name, ''), coalesce(c.rarity, ''),
                lower(trim(coalesce(nullif(c.artist, ''), c.illustrator, ''))), coalesce(c.version, ''),
                c.pokedex_num, c.expansion_sort, coalesce(c.search_weight, 0)::float8, coalesce(e.nationality, '')
         from public.marketplace_search_candidates c
         left join (select name, min(nationality) as nationality from public.pokoin_pokemon_expansions group by name) e
           on e.name = c.set_name
         where c.item_kind = 'single' and c.product_type = 'card'
           and coalesce(c.cdn_image_url, c.image_url) is not null
         order by c.card_id",
    )
    .fetch_all(pool)
    .await?;
    // Two joins, not one `on a or b`: the OR join is a nested loop (5 min on
    // nezopt), the union two index joins (0.2 s).
    let listed: HashSet<i64> = sqlx::query_scalar::<_, i64>(
        "with p as (
           select blueprint_id, pokoin_card_id from public.cheapest_homepage_cache_blueprint
           where provider in ('cardtrader', 'pokoin_native') and cheapest_price_pkn > 0
             and coalesce(eligible_listing_count, 0) > 0
         )
         select c.card_id from p join public.marketplace_search_candidates c on c.ct_id = p.blueprint_id
         union
         select c.card_id from p join public.marketplace_search_candidates c on c.card_id::text = p.pokoin_card_id",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    let top = rows.iter().map(|r| r.8).fold(0.0_f64, f64::max).max(1e-9);
    Ok(rows
        .into_iter()
        .map(|(id, name, set, rarity, artist, version, dex, sort, weight, language)| Card {
            listed: listed.contains(&id),
            popularity: (weight.max(0.0) / top) as f32,
            id,
            name,
            set,
            rarity,
            artist,
            version,
            dex: dex.unwrap_or(0),
            sort: sort.unwrap_or(0),
            language,
        })
        .collect())
}

/// Cards whose own row or price changed after `since`.
pub async fn changed_since(pool: &PgPool, since: &str) -> anyhow::Result<HashSet<i64>> {
    let ids: Vec<i64> = sqlx::query_scalar(
        "select c.card_id from public.marketplace_search_candidates c
         where greatest(c.projected_at, c.imported_at) > $1::timestamptz
         union
         select c.card_id
         from public.cheapest_homepage_cache_blueprint p
         join public.marketplace_search_candidates c on c.ct_id = p.blueprint_id
         where p.updated_at > $1::timestamptz
         union
         select c.card_id
         from public.cheapest_homepage_cache_blueprint p
         join public.marketplace_search_candidates c on c.card_id::text = p.pokoin_card_id
         where p.updated_at > $1::timestamptz",
    )
    .bind(since)
    .fetch_all(pool)
    .await?;
    Ok(ids.into_iter().collect())
}

/// Tile rows in the list-snapshot `cards` shape (expansion-page row, daily
/// median where no ask, one key order), serialised, by public card id.
pub async fn tile_rows(pool: &PgPool, ids: &[i64], language: &HashMap<i64, &str>) -> anyhow::Result<HashMap<i64, String>> {
    let mut out = HashMap::with_capacity(ids.len());
    for chunk in ids.chunks(2_000) {
        let rows = react_sql::read_candidates_by_card_ids(pool, true, chunk).await?;
        let blueprints: Vec<i64> = rows
            .iter()
            .filter_map(|row| {
                let n = js::number(js::get(row, "ct_id"));
                (js::is_safe_integer(n) && n > 0.0).then_some(n as i64)
            })
            .collect();
        let paths = react_sql::read_canonical_paths(pool, chunk).await?;
        let cheapest = react_sql::read_cheapest_map(pool, true, chunk, &blueprints).await;
        let rows = react_sql::apply_canonical_and_cheapest(&rows, &paths, &cheapest);
        let mut cards = react_card::to_react_cards(&rows);
        for card in &mut cards {
            // The set desk stamps its print nationality on rows without one.
            let id = card_id(card);
            if js::string_or_empty(js::get(card, "nationality")).is_empty() {
                if let Some(print) = language.get(&id).filter(|p| !p.is_empty()) {
                    card["nationality"] = json!(print);
                }
            }
        }
        let mut body = json!({ "cards": cards });
        crate::lists::fill_medians(pool, &mut body).await;
        let body = crate::lists::canonical_rows(&body);
        for card in body.get("cards").and_then(Value::as_array).into_iter().flatten() {
            out.insert(card_id(card), page_snapshot::text(card));
        }
    }
    Ok(out)
}

fn card_id(card: &Value) -> i64 {
    card.get("id")
        .or_else(|| card.get("card_id"))
        .and_then(|v| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_i64()))
        .unwrap_or(0)
}

/// `/api/marketplace-related` body for one card.
pub fn related_bytes(card_id: &str, rows: &[String]) -> Vec<u8> {
    page_snapshot::Body::with_capacity(rows).value("cardId", &json!(card_id)).rows("related", rows).finish()
}

/// The stored `c1` of [`related_bytes`].
pub fn related_c1(card_id: &str, rows: &[String]) -> Vec<u8> {
    match serde_json::from_slice::<Value>(&related_bytes(card_id, rows)) {
        Ok(body) => compact::encode::encode_to_vec(&body),
        Err(_) => Vec::new(),
    }
}

/// The stored neighbours of one card, parsed for embedding in the card page.
/// Empty when the card has no snapshot (a satellite game, a card newer than
/// the last build): the client then uses its own picker.
pub async fn for_card_page(pool: &PgPool, card_id: i64, game: &str) -> Vec<Value> {
    if game != "pokemon" {
        return Vec::new();
    }
    match page_snapshot::read(pool, page_snapshot::RELATED, &card_id.to_string(), 0, RELATED_MAX as i64, false).await {
        Some(page) => page.rows.iter().filter_map(|row| serde_json::from_str(row).ok()).collect(),
        None => Vec::new(),
    }
}

/// Related tiles change when the daily build or a delta rewrites them.
const RELATED_CACHE: &str = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

/// `GET /api/marketplace-related?cardId=<public id>[&format=c1]`:
/// `{"cardId":"…","related":[tile rows]}`, at most 12, best first. An unknown
/// card or one without a snapshot answers an empty list (briefly cached).
pub async fn handler(
    axum::extract::State(state): axum::extract::State<crate::AppState>,
    headers: axum::http::HeaderMap,
    uri: axum::http::Uri,
) -> axum::response::Response {
    use axum::http::StatusCode;
    use crate::catalog_api;
    let p = catalog_api::params(&uri);
    let Some(id) = catalog_api::positive_id(p.get("cardId").or_else(|| p.get("id")).map(String::as_str).unwrap_or("")) else {
        return catalog_api::response(StatusCode::BAD_REQUEST, json!({"error": "cardId is required (public marketplace id)."}), "");
    };
    let game = crate::suggest::game_from(&headers, p.get("game").map(String::as_str));
    let Some(pool) = catalog_api::game_pool(&state, &game).await else {
        return catalog_api::response(StatusCode::SERVICE_UNAVAILABLE, json!({"error": "Marketplace database unavailable."}), "no-store");
    };
    let wanted = catalog_api::wanted(&headers, &uri);
    let key = id.to_string();
    let page = if game == "pokemon" {
        page_snapshot::read(&pool, page_snapshot::RELATED, &key, 0, RELATED_MAX as i64, wanted.c1()).await
    } else {
        None
    };
    let cors: Vec<(&str, &str)> = pokoin_api_common::http::READ_CORS.to_vec();
    match page {
        Some(page) => {
            let mut headers = cors;
            headers.push(("cache-control", RELATED_CACHE));
            compact::prebuilt(wanted, related_bytes(&key, &page.rows), page.c1.filter(|c| !c.is_empty()), &headers)
        }
        None => {
            let mut headers = cors;
            headers.push(("cache-control", "public, max-age=60, s-maxage=300"));
            compact::prebuilt(wanted, related_bytes(&key, &[]), None, &headers)
        }
    }
}

/// Which cards a delta build rewrites: changed cards, cards showing a changed
/// card, and cards that have no snapshot yet.
pub fn affected(cards: &[Card], lists: &[Vec<u32>], changed: &HashSet<i64>, stored: &HashSet<i64>) -> Vec<usize> {
    (0..cards.len())
        .filter(|&i| {
            !stored.contains(&cards[i].id)
                || changed.contains(&cards[i].id)
                || lists[i].iter().any(|&j| changed.contains(&cards[j as usize].id))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: i64, name: &str, set: &str, dex: i32) -> Card {
        Card { id, name: name.into(), set: set.into(), dex, ..Default::default() }
    }

    #[test]
    fn the_spa_weights_are_kept() {
        let a = Card { rarity: "Rare".into(), artist: "ken sugimori".into(), ..card(2, "pikachu", "Base Set", 25) };
        let mut b = a.clone();
        b.id = 4;
        assert_eq!(score(&a, &b), SAME_DEX + SAME_SET + SAME_NAME + SAME_ARTIST + SAME_RARITY);
        assert_eq!(score(&a, &a), 0.0);
        assert_eq!(score(&a, &card(6, "mew", "Fossil", 151)), 0.0);
    }

    #[test]
    fn neighbours_are_ranked_capped_and_never_the_card_itself() {
        let mut cards: Vec<Card> = (0..40).map(|i| card(2 * (i + 1), "pikachu", &format!("Set {i}"), 25)).collect();
        cards.push(card(1000, "raichu", "Set 0", 26));
        cards.push(Card { version: "v1".into(), ..card(1002, "pikachu", "Set 0", 25) });
        cards[0].version = "v1".into();
        let lists = neighbours(&cards);
        assert!(lists.iter().all(|l| l.len() <= RELATED_MAX));
        assert!(lists.iter().enumerate().all(|(i, l)| !l.contains(&(i as u32))));
        // Same artwork + set + name + dex beats everything else for card 0.
        assert_eq!(cards[lists[0][0] as usize].id, 1002);
        // Ties fall back to the lower public id.
        assert_eq!(cards[lists[0][1] as usize].id, 4);
        // The evolution-line proxy proposes Raichu's Pikachus.
        let raichu = &lists[cards.iter().position(|c| c.id == 1000).unwrap()];
        assert_eq!(raichu.len(), RELATED_MAX);
        assert_eq!(cards[raichu[0] as usize].set, "Set 0");
    }

    #[test]
    fn availability_and_popularity_only_break_ties() {
        let a = card(2, "eevee", "Jungle", 133);
        let plain = card(4, "eevee", "Fossil", 133);
        let listed = Card { listed: true, popularity: 1.0, ..card(6, "eevee", "Fossil", 133) };
        let better = card(8, "eevee", "Jungle", 133);
        assert!(score(&a, &listed) > score(&a, &plain));
        assert!(score(&a, &better) > score(&a, &listed));
    }

    #[test]
    fn a_delta_rewrites_changed_cards_their_viewers_and_new_cards() {
        let cards: Vec<Card> = vec![card(2, "a", "S", 1), card(4, "a", "S", 1), card(6, "z", "T", 900), card(8, "q", "U", 500)];
        let lists = neighbours(&cards);
        let stored: HashSet<i64> = [2, 4, 6].into_iter().collect();
        let changed: HashSet<i64> = [4].into_iter().collect();
        // 4 changed, 2 shows 4, 8 has no snapshot; 6 is untouched.
        assert_eq!(affected(&cards, &lists, &changed, &stored), vec![0, 1, 3]);
    }

    #[test]
    fn the_related_body_is_plain_json() {
        let rows = vec![json!({"id": "4", "name": "Mew"}).to_string()];
        assert_eq!(String::from_utf8(related_bytes("2", &rows)).unwrap(), json!({"cardId": "2", "related": [{"id": "4", "name": "Mew"}]}).to_string());
        assert!(compact::decode::decode(&serde_json::from_slice(&related_c1("2", &rows)).unwrap()).is_ok());
    }
}
