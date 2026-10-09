//! `GET|OPTIONS /api/marketplace-competitive` — port of `marketplace-competitive.js`
//! (Limitless tournaments, meta decks and decklists). SQL is verbatim in
//! `competitive_sql.rs`; `${...}` slots are filled here like the JS templates.

use std::sync::OnceLock;

use axum::extract::State;
use axum::http::{Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use pokoin_api_common::pg::{self, Bind};
use pokoin_api_common::{http, RouteState};
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use super::common::{encode_uri_component, failed, num0, num_or_null, or_chain, or_empty, raw, with_headers};
use super::competitive_sql as q;
use crate::shared::js;

const CORS: [(&str, &str); 4] = [
    ("access-control-allow-origin", "*"),
    ("access-control-allow-methods", "GET, OPTIONS"),
    ("access-control-allow-headers", "Content-Type, Authorization"),
    ("access-control-max-age", "86400"),
];

type Res<T> = Result<T, sqlx::Error>;

pub fn clean_limit(value: Option<&str>, fallback: i64, max: i64) -> i64 {
    let Some(text) = value.filter(|v| !v.is_empty()) else { return fallback };
    match http::js_number(text) {
        Some(n) if n.is_finite() => (n.trunc() as i64).clamp(1, max),
        _ => fallback,
    }
}

fn clean_text(value: Option<&str>, max: usize) -> String {
    js::clean_text_str(value.unwrap_or(""), max)
}

pub fn clean_tournament_id(value: Option<&str>) -> String {
    clean_text(value, 64).chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect()
}

fn clean_deck_id(value: Option<&str>) -> String {
    clean_text(value, 32).chars().filter(char::is_ascii_digit).collect()
}

fn clean_decklist_id_str(value: &str) -> String {
    let clean = js::clean_text_str(value, 120);
    if clean == "[object Object]" { String::new() } else { clean }
}

fn clean_decklist_id(value: Option<&Value>) -> String {
    match value {
        Some(Value::Object(_)) => String::new(),
        other => clean_decklist_id_str(&js::string_or_empty(other)),
    }
}

fn clean_year(value: Option<&str>) -> Option<i32> {
    let n = match value {
        None => 0.0,
        Some(text) => http::js_number(text).unwrap_or(f64::NAN),
    };
    if !js::is_safe_integer(n) || !(2000.0..=2100.0).contains(&n) {
        return None;
    }
    Some(n as i32)
}

fn wants(value: Option<&str>) -> bool {
    matches!(value, Some("1" | "true" | "yes"))
}

fn is_missing_public_limitless_table(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .is_some_and(|db| db.code().as_deref() == Some("42P01") && db.message().contains("limitless_public_"))
}

async fn rows(pool: &PgPool, sql: &str, binds: &[Bind]) -> Res<Vec<Value>> {
    pg::pool_rows(pool, sql, binds).await
}

async fn has_blueprint_mapping_table(pool: &PgPool) -> Res<bool> {
    static CACHE: OnceLock<bool> = OnceLock::new();
    if let Some(v) = CACHE.get() {
        return Ok(*v);
    }
    let exists = match rows(pool, "select to_regclass('public.limitless_marketplace_expansion_blueprints') is not null as exists", &[]).await {
        Ok(r) => r.first().and_then(|row| row.get("exists")).and_then(Value::as_bool) == Some(true),
        Err(error) if error.as_database_error().and_then(|d| d.code()).as_deref() == Some("42P01") => false,
        Err(error) => return Err(error),
    };
    let _ = CACHE.set(exists);
    Ok(exists)
}

fn tournament_from_row(row: &Value) -> Value {
    json!({
        "id": raw(row, "tournament_id"),
        "name": or_empty(row, "name"),
        "game": or_empty(row, "game_id"),
        "gameName": or_chain(row, &["game_name", "game_id"], json!("")),
        "format": or_empty(row, "format"),
        "formatLabel": or_chain(row, &["format_label", "format"], json!("")),
        "date": raw(row, "tournament_date"),
        "players": num0(row, "player_count"),
        "organizerId": raw(row, "organizer_id"),
        "organizerName": or_empty(row, "organizer_name"),
        "platform": or_empty(row, "platform"),
        "decklistsAvailable": row.get("decklists_available") == Some(&json!(true)),
        "isPublic": row.get("is_public") != Some(&json!(false)),
        "isOnline": row.get("is_online") == Some(&json!(true)),
        "phases": or_chain(row, &["phases"], json!([])),
        "sourceUrl": or_empty(row, "source_url"),
        "detailsFetchedAt": raw(row, "details_fetched_at"),
        "standingsFetchedAt": raw(row, "standings_fetched_at"),
        "pairingsFetchedAt": raw(row, "pairings_fetched_at"),
        "updatedAt": raw(row, "updated_at"),
    })
}

fn public_tournament_from_row(row: &Value) -> Value {
    json!({
        "id": raw(row, "tournament_id"),
        "name": or_empty(row, "name"),
        "game": "PTCG",
        "gameName": "Pokemon TCG",
        "format": or_empty(row, "format"),
        "formatLabel": or_chain(row, &["format_label", "format"], json!("")),
        "date": raw(row, "tournament_date"),
        "players": num0(row, "player_count"),
        "organizerId": null,
        "organizerName": or_chain(row, &["country_name", "country"], json!("")),
        "platform": "Limitless",
        "decklistsAvailable": true,
        "isPublic": true,
        "isOnline": false,
        "phases": [],
        "sourceUrl": or_empty(row, "source_url"),
        "detailsFetchedAt": raw(row, "source_fetched_at"),
        "standingsFetchedAt": raw(row, "source_fetched_at"),
        "pairingsFetchedAt": null,
        "updatedAt": raw(row, "updated_at"),
        "winnerName": or_empty(row, "winner_name"),
        "winnerCountry": or_empty(row, "winner_country"),
    })
}

fn standing_from_row(row: &Value) -> Value {
    json!({
        "placing": raw(row, "placing"),
        "playerId": or_empty(row, "player_id"),
        "name": or_chain(row, &["display_name", "player_id"], json!("")),
        "country": or_empty(row, "country"),
        "record": { "wins": num0(row, "wins"), "losses": num0(row, "losses"), "ties": num0(row, "ties") },
        "dropRound": raw(row, "drop_round"),
        "deckName": or_empty(row, "deck_name"),
        "deckArchetype": or_empty(row, "deck_archetype"),
        "decklistId": clean_decklist_id(row.get("decklist_id")),
        "deckSummary": or_chain(row, &["deck_summary"], json!({})),
    })
}

fn pairing_from_row(row: &Value) -> Value {
    json!({
        "phase": num0(row, "phase"),
        "round": num0(row, "round"),
        "table": num0(row, "table_number"),
        "player1Id": or_empty(row, "player1_id"),
        "player1Name": or_chain(row, &["player1_name", "player1_id"], json!("")),
        "player2Id": or_empty(row, "player2_id"),
        "player2Name": or_chain(row, &["player2_name", "player2_id"], json!("")),
        "winnerPlayerId": or_empty(row, "winner_player_id"),
        "result": or_empty(row, "result"),
    })
}

fn public_standing_from_row(row: &Value) -> Value {
    json!({
        "placing": raw(row, "placing"),
        "playerId": or_empty(row, "player_id"),
        "name": or_chain(row, &["player_name", "player_id"], json!("")),
        "country": or_empty(row, "country"),
        "record": { "wins": 0, "losses": 0, "ties": 0 },
        "dropRound": null,
        "deckName": or_empty(row, "deck_name"),
        "deckArchetype": or_chain(row, &["variant", "deck_name"], json!("")),
        "decklistId": clean_decklist_id(row.get("decklist_id")),
        "deckSummary": { "deckId": or_empty(row, "deck_id"), "sourceUrl": or_empty(row, "source_url") },
    })
}

fn game_from_row(row: &Value) -> Value {
    json!({
        "id": or_empty(row, "game_id"),
        "name": or_chain(row, &["name", "game_id"], json!("")),
        "formats": or_chain(row, &["formats"], json!({})),
        "platforms": or_chain(row, &["platforms"], json!({})),
        "metagame": row.get("metagame") == Some(&json!(true)),
    })
}

fn string_or_empty_if_truthy(row: &Value, key: &str) -> Value {
    match row.get(key).filter(|v| js::truthy(Some(v))) {
        Some(v) => json!(js::js_string(v)),
        None => json!(""),
    }
}

fn top_deck_from_row(row: &Value) -> Value {
    json!({
        "deckId": string_or_empty_if_truthy(row, "deck_id"),
        "archetype": or_chain(row, &["archetype"], json!("Unknown deck")),
        "game": or_empty(row, "game_id"),
        "format": or_empty(row, "format"),
        "formatLabel": or_chain(row, &["format_label", "format"], json!("")),
        "count": num0(row, "deck_count"),
        "share": num0(row, "share"),
        "points": num0(row, "points"),
        "featuredPlayer": or_empty(row, "featured_player"),
        "featuredPlacing": raw(row, "featured_placing"),
        "featuredRecord": { "wins": num0(row, "featured_wins"), "losses": num0(row, "featured_losses"), "ties": num0(row, "featured_ties") },
        "featuredTournamentId": or_empty(row, "featured_tournament_id"),
        "featuredTournamentName": or_empty(row, "featured_tournament_name"),
        "featuredTournamentDate": or_chain(row, &["featured_tournament_date"], Value::Null),
        "featuredDecklistId": clean_decklist_id(row.get("featured_decklist_id")),
        "representativeCardId": string_or_empty_if_truthy(row, "representative_card_id"),
        "representativeCardName": or_empty(row, "representative_card_name"),
        "representativeCardSetName": or_empty(row, "representative_card_set_name"),
        "representativeCardNumber": or_empty(row, "representative_card_number"),
        "representativeCardPath": or_empty(row, "representative_card_path"),
        "imageUrl": or_empty(row, "representative_image_url"),
        "cardImageUrl": or_empty(row, "representative_image_url"),
        "sourceUrl": or_empty(row, "source_url"),
    })
}

fn deck_card_from_row(row: &Value) -> Value {
    json!({
        "name": or_chain(row, &["display_name", "card_name"], json!("")),
        "count": num_or_null(row, "count"),
        "inclusionShare": num_or_null(row, "inclusion_share"),
        "section": or_empty(row, "section"),
        "setCode": or_empty(row, "set_code"),
        "collectorNumber": or_empty(row, "collector_number"),
        "sourceUrl": or_empty(row, "source_url"),
        "marketplaceCardId": string_or_empty_if_truthy(row, "marketplace_card_id"),
        "marketplacePath": or_empty(row, "marketplace_card_path"),
        "imageUrl": or_empty(row, "marketplace_image_url"),
    })
}

fn deck_result_from_row(row: &Value) -> Value {
    json!({
        "tournamentId": or_empty(row, "tournament_id"),
        "tournamentName": or_empty(row, "tournament_name"),
        "tournamentDate": or_chain(row, &["tournament_date"], Value::Null),
        "format": or_empty(row, "format"),
        "placing": raw(row, "placing"),
        "placingLabel": or_empty(row, "placing_label"),
        "variant": or_empty(row, "variant"),
        "playerId": or_empty(row, "player_id"),
        "playerName": or_empty(row, "player_name"),
        "decklistId": clean_decklist_id(row.get("decklist_id")),
        "sourceUrl": or_empty(row, "source_url"),
    })
}

fn decklist_detail_from_row(row: &Value) -> Value {
    let decklist_id = clean_decklist_id(row.get("decklist_id"));
    let source_url = match row.get("source_url").filter(|v| js::truthy(Some(v))) {
        Some(v) => v.clone(),
        None if !decklist_id.is_empty() => json!(format!("https://limitlesstcg.com/decks/list/{}", encode_uri_component(&decklist_id))),
        None => json!(""),
    };
    json!({
        "decklistId": decklist_id,
        "deckId": string_or_empty_if_truthy(row, "deck_id"),
        "deckName": or_chain(row, &["deck_name", "name"], json!("")),
        "format": or_empty(row, "format"),
        "formatLabel": or_chain(row, &["format_label", "format"], json!("")),
        "tournamentId": or_empty(row, "tournament_id"),
        "tournamentName": or_empty(row, "tournament_name"),
        "tournamentDate": or_chain(row, &["tournament_date"], Value::Null),
        "placing": raw(row, "placing"),
        "placingLabel": or_empty(row, "placing_label"),
        "variant": or_empty(row, "variant"),
        "playerId": or_empty(row, "player_id"),
        "playerName": or_empty(row, "player_name"),
        "sourceUrl": source_url,
        "deckSourceUrl": or_empty(row, "deck_source_url"),
        "tournamentSourceUrl": or_empty(row, "tournament_source_url"),
    })
}

fn deck_player_from_row(row: &Value) -> Value {
    json!({
        "playerId": or_empty(row, "player_id"),
        "playerName": or_empty(row, "player_name"),
        "country": or_empty(row, "country"),
        "rank": raw(row, "rank"),
        "points": num0(row, "points"),
        "sourceUrl": or_empty(row, "source_url"),
    })
}

fn deck_detail_from_row(row: &Value) -> Value {
    let points = or_chain(row, &["points", "total_points"], json!(0));
    json!({
        "id": or_empty(row, "deck_id"),
        "name": or_empty(row, "name"),
        "format": or_empty(row, "format"),
        "formatLabel": or_chain(row, &["format_label", "format"], json!("")),
        "rank": raw(row, "rank"),
        "points": js::js_json_number(js::number(Some(&points))),
        "share": num0(row, "share"),
        "earningsText": or_empty(row, "earnings_text"),
        "totalPoints": num0(row, "total_points"),
        "regionalTop8": num0(row, "regional_top8"),
        "regionalWins": num0(row, "regional_wins"),
        "internationalTop8": num0(row, "international_top8"),
        "internationalWins": num0(row, "international_wins"),
        "variants": row.get("variants").filter(|v| v.is_array()).cloned().unwrap_or(json!([])),
        "sourceUrl": or_empty(row, "source_url"),
        "updatedAt": raw(row, "updated_at"),
    })
}

/// `deckCardImageJoinSql(alias, nameColumn, { useBlueprintMapping, useFallbackScan: false })`.
/// Production always runs with the module query, so the fallback scan is off.
fn deck_card_image_join_sql(alias: &str, name_column: &str, use_blueprint_mapping: bool) -> String {
    let source_name = format!("{alias}.{name_column}");
    let mapped = if use_blueprint_mapping {
        format!(
            r#"left join lateral (
        select
          c.card_id,
          coalesce(urls.canonical_path, '') as marketplace_card_path,
          coalesce(
            nullif(c.preview_image_url, ''),
            nullif(c.homepage_image_url, ''),
            nullif(c.cdn_image_url, ''),
            nullif(c.image_url, ''),
            ''
          ) as marketplace_image_url
        from public.limitless_marketplace_expansion_blueprints mapping
        join public.marketplace_search_candidates c
          on c.card_id = mapping.blueprint_id
        left join public.marketplace_card_urls urls
          on urls.card_id = c.card_id and urls.language = 'en'
        where c.item_kind = 'single'
          and (
            nullif({alias}.set_code, '') is null
            or lower(mapping.set_code) = lower({alias}.set_code)
          )
          and (
            nullif({alias}.collector_number, '') is null
            or mapping.normalized_collector_number = regexp_replace(
              lower(coalesce(substring({alias}.collector_number from '[A-Za-z]*0*([0-9]+[A-Za-z]?)'), {alias}.collector_number)),
              '[^a-z0-9]+',
              '',
              'g'
            )
          )
          and (
            regexp_replace(lower(mapping.card_name), '[^a-z0-9]+', '', 'g') =
              regexp_replace(lower(coalesce({source_name}, '')), '[^a-z0-9]+', '', 'g')
            or regexp_replace(lower(mapping.limitless_card_name), '[^a-z0-9]+', '', 'g') =
              regexp_replace(lower(coalesce({source_name}, '')), '[^a-z0-9]+', '', 'g')
          )
        order by mapping.match_confidence desc, c.search_weight desc, c.imported_at desc nulls last, c.card_id asc
        limit 1
      ) mapped_card on true"#
        )
    } else {
        "
      left join lateral (
        select
          null::bigint as card_id,
          ''::text as marketplace_card_path,
          ''::text as marketplace_image_url
        where false
      ) mapped_card on true"
            .to_owned()
    };
    format!(
        "
      {mapped}
      
      left join lateral (
        select
          null::bigint as card_id,
          ''::text as marketplace_card_path,
          ''::text as marketplace_image_url
        where false
      ) fallback_card on true
  "
    )
}

struct Filters {
    where_sql: String,
    values: Vec<Bind>,
}

fn build_tournament_filters(game: Option<&str>, format: Option<&str>, year: Option<&str>) -> Filters {
    let mut values = Vec::new();
    let mut where_sql = "where true".to_owned();
    let game = clean_text(game, 24).to_uppercase();
    let format = clean_text(format, 40).to_uppercase();
    if !game.is_empty() {
        values.push(Bind::Text(game));
        where_sql += &format!(" and t.game_id = ${}", values.len());
    }
    if !format.is_empty() {
        values.push(Bind::Text(format));
        where_sql += &format!(" and upper(t.format) = ${}", values.len());
    }
    if let Some(year) = clean_year(year) {
        values.push(Bind::Int4(year));
        where_sql += &format!(" and t.tournament_date >= make_timestamptz(${}, 1, 1, 0, 0, 0)", values.len());
        values.push(Bind::Int4(year + 1));
        where_sql += &format!(" and t.tournament_date < make_timestamptz(${}, 1, 1, 0, 0, 0)", values.len());
    }
    Filters { where_sql, values }
}

fn fill(sql: &str, where_sql: &str, limit_index: usize) -> String {
    sql.replace("$${values.length}", &format!("${limit_index}")).replace("${where}", where_sql)
}

async fn fetch_games(pool: &PgPool) -> Res<Vec<Value>> {
    Ok(rows(pool, q::SQL_0, &[]).await?.iter().map(game_from_row).collect())
}

async fn fetch_tournament_list(pool: &PgPool, game: Option<&str>, format: Option<&str>, year: Option<&str>, limit: Option<&str>) -> Res<Vec<Value>> {
    let Filters { where_sql, mut values } = build_tournament_filters(game, format, year);
    values.push(Bind::Int(clean_limit(limit, 40, 120)));
    let sql = fill(q::SQL_1, &where_sql, values.len());
    Ok(rows(pool, &sql, &values).await?.iter().map(tournament_from_row).collect())
}

async fn fetch_public_top_decks(pool: &PgPool, format: Option<&str>, year: Option<&str>) -> Res<Vec<Value>> {
    let mut values = Vec::new();
    let mut where_sql = "where true".to_owned();
    let format = clean_text(format, 40).to_uppercase();
    if !format.is_empty() {
        values.push(Bind::Text(format));
        where_sql += &format!(" and (upper(d.format) = ${} or d.format is null)", values.len());
    }
    if let Some(year) = clean_year(year) {
        values.push(Bind::Int4(year));
        let n = values.len();
        where_sql += &format!(
            " and exists (
      select 1
      from public.limitless_public_deck_results r
      where r.deck_id = d.deck_id
        and r.tournament_date >= make_date(${n}, 1, 1)
        and r.tournament_date < make_date(${n} + 1, 1, 1)
    )"
        );
    }
    values.push(Bind::Int(clean_limit(Some("8"), 8, 24)));
    let sql = fill(q::SQL_3, &where_sql, values.len());
    Ok(rows(pool, &sql, &values).await?.iter().map(top_deck_from_row).collect())
}

async fn fetch_top_decks(pool: &PgPool, game: Option<&str>, format: Option<&str>, year: Option<&str>) -> Res<Vec<Value>> {
    let public = match fetch_public_top_decks(pool, format, year).await {
        Ok(decks) => decks,
        Err(error) if is_missing_public_limitless_table(&error) => Vec::new(),
        Err(error) => return Err(error),
    };
    if !public.is_empty() {
        return Ok(public);
    }
    let Filters { where_sql, mut values } = build_tournament_filters(game, format, year);
    values.push(Bind::Int(clean_limit(Some("8"), 8, 24)));
    let sql = fill(q::SQL_2, &where_sql, values.len());
    Ok(rows(pool, &sql, &values).await?.iter().map(top_deck_from_row).collect())
}

async fn fetch_public_tournament_group(pool: &PgPool, format: Option<&str>, year: Option<&str>) -> Res<Vec<Value>> {
    let mut values = Vec::new();
    let mut where_sql = "where true".to_owned();
    let format = clean_text(format, 40).to_uppercase();
    if !format.is_empty() {
        values.push(Bind::Text(format));
        where_sql += &format!(" and upper(t.format) = ${}", values.len());
    }
    if let Some(year) = clean_year(year) {
        values.push(Bind::Int4(year));
        where_sql += &format!(" and t.tournament_date >= make_date(${}, 1, 1)", values.len());
        values.push(Bind::Int4(year + 1));
        where_sql += &format!(" and t.tournament_date < make_date(${}, 1, 1)", values.len());
    }
    values.push(Bind::Int(8));
    let sql = fill(q::SQL_5, &where_sql, values.len());
    Ok(rows(pool, &sql, &values).await?.iter().map(public_tournament_from_row).collect())
}

async fn fetch_tournament_group(pool: &PgPool, game: Option<&str>, format: Option<&str>, year: Option<&str>, group: &str) -> Res<Vec<Value>> {
    if group == "recent" {
        let public = match fetch_public_tournament_group(pool, format, year).await {
            Ok(list) => list,
            Err(error) if is_missing_public_limitless_table(&error) => Vec::new(),
            Err(error) => return Err(error),
        };
        if !public.is_empty() {
            return Ok(public);
        }
    }
    let Filters { where_sql, mut values } = build_tournament_filters(game, format, year);
    let (group_filter, order_by) = match group {
        "upcoming" => ("and t.tournament_date >= now()", "t.tournament_date asc nulls last, t.player_count desc, t.tournament_id desc"),
        "city" => ("and t.is_online is false", "t.tournament_date desc nulls last, t.player_count desc, t.tournament_id desc"),
        _ => ("and (t.tournament_date is null or t.tournament_date <= now())", "t.tournament_date desc nulls last, t.player_count desc, t.tournament_id desc"),
    };
    values.push(Bind::Int(8));
    let sql = fill(q::SQL_4, &where_sql, values.len()).replace("${groupFilter}", group_filter).replace("${orderBy}", order_by);
    Ok(rows(pool, &sql, &values).await?.iter().map(tournament_from_row).collect())
}

async fn fetch_dashboard(pool: &PgPool, game: Option<&str>, format: Option<&str>, year: Option<&str>) -> Res<Value> {
    let (top, recent, upcoming, city) = tokio::try_join!(
        fetch_top_decks(pool, game, format, year),
        fetch_tournament_group(pool, game, format, year, "recent"),
        fetch_tournament_group(pool, game, format, year, "upcoming"),
        fetch_tournament_group(pool, game, format, year, "city"),
    )?;
    Ok(json!({ "topDecks": top, "recentTournaments": recent, "upcomingTournaments": upcoming, "cityLeagues": city }))
}

async fn fetch_years(pool: &PgPool, game: Option<&str>, format: Option<&str>) -> Res<Vec<Value>> {
    let Filters { where_sql, values } = build_tournament_filters(game, format, None);
    let sql = q::SQL_6.replace("${where}", &where_sql);
    Ok(rows(pool, &sql, &values)
        .await?
        .iter()
        .map(|r| js::number(r.get("year")))
        .filter(|n| js::is_safe_integer(*n))
        .map(|n| json!(n as i64))
        .collect())
}

async fn fetch_tournament_snapshot(pool: &PgPool, id: &str, standings_limit: Option<&str>, pairings_limit: Option<&str>) -> Res<Option<Value>> {
    if id.is_empty() {
        return Ok(None);
    }
    let found = rows(pool, q::SQL_7, &[Bind::Text(id.to_owned())]).await?;
    let Some(row) = found.first() else { return Ok(None) };
    let standings = rows(pool, q::SQL_8, &[Bind::Text(id.to_owned()), Bind::Int(clean_limit(standings_limit, 80, 300))]).await?;
    let pairings = rows(pool, q::SQL_9, &[Bind::Text(id.to_owned()), Bind::Int(clean_limit(pairings_limit, 120, 500))]).await?;
    Ok(Some(json!({
        "tournament": tournament_from_row(row),
        "standings": standings.iter().map(standing_from_row).collect::<Vec<_>>(),
        "pairings": pairings.iter().map(pairing_from_row).collect::<Vec<_>>(),
    })))
}

async fn fetch_public_tournament_snapshot(pool: &PgPool, id: &str, standings_limit: Option<&str>) -> Res<Option<Value>> {
    if id.is_empty() {
        return Ok(None);
    }
    let found = rows(pool, q::SQL_10, &[Bind::Text(id.to_owned())]).await?;
    let Some(row) = found.first() else { return Ok(None) };
    let standings = rows(pool, q::SQL_11, &[Bind::Text(id.to_owned()), Bind::Int(clean_limit(standings_limit, 80, 300))]).await?;
    Ok(Some(json!({
        "tournament": public_tournament_from_row(row),
        "standings": standings.iter().map(public_standing_from_row).collect::<Vec<_>>(),
        "pairings": [],
    })))
}

struct DeckLimits<'a> {
    result: Option<&'a str>,
    card: Option<&'a str>,
    player: Option<&'a str>,
    decklist: Option<&'a str>,
}

async fn fetch_deck_detail(pool: &PgPool, id: &str, limits: DeckLimits<'_>) -> Res<Option<Value>> {
    if id.is_empty() {
        return Ok(None);
    }
    let mapping = has_blueprint_mapping_table(pool).await?;
    let found = rows(pool, q::SQL_12, &[Bind::Text(id.to_owned())]).await?;
    let Some(row) = found.first() else { return Ok(None) };
    let cards_sql = q::SQL_13.replace("${JOIN}", &deck_card_image_join_sql("core", "display_name", mapping));
    let cards = rows(pool, &cards_sql, &[Bind::Text(id.to_owned()), Bind::Int(clean_limit(limits.card, 24, 80))]).await?;
    let results = rows(pool, q::SQL_14, &[Bind::Text(id.to_owned()), Bind::Int(clean_limit(limits.result, 80, 300))]).await?;
    let players = rows(pool, q::SQL_15, &[Bind::Text(id.to_owned()), Bind::Int(clean_limit(limits.player, 10, 50))]).await?;
    let decklist_ids: Vec<String> = results
        .iter()
        .map(|r| clean_decklist_id(r.get("decklist_id")))
        .filter(|id| !id.is_empty())
        .take(clean_limit(limits.decklist, 4, 20) as usize)
        .collect();
    let mut decklists = Vec::new();
    if !decklist_ids.is_empty() {
        let sql = q::SQL_16.replace("${JOIN}", &deck_card_image_join_sql("deck_card", "card_name", mapping));
        let cards = rows(pool, &sql, &[Bind::TextArray(decklist_ids.clone())]).await?;
        for decklist_id in &decklist_ids {
            let base = results.iter().find(|r| clean_decklist_id(r.get("decklist_id")) == *decklist_id).cloned().unwrap_or(json!({}));
            let mut merged: Map<String, Value> = base.as_object().cloned().unwrap_or_default();
            merged.insert("decklist_id".into(), json!(decklist_id));
            merged.insert("deck_id".into(), json!(id));
            merged.insert("deck_name".into(), or_empty(row, "name"));
            merged.insert("format_label".into(), or_chain(row, &["format_label", "format"], json!("")));
            merged.insert("deck_source_url".into(), or_empty(row, "source_url"));
            let mut detail = decklist_detail_from_row(&Value::Object(merged));
            let grouped: Vec<Value> = cards
                .iter()
                .filter(|c| c.get("decklist_id").map(js::js_string).as_deref() == Some(decklist_id.as_str()))
                .map(deck_card_from_row)
                .collect();
            detail["cards"] = Value::Array(grouped);
            decklists.push(detail);
        }
    }
    Ok(Some(json!({
        "deck": deck_detail_from_row(row),
        "coreCards": cards.iter().map(deck_card_from_row).collect::<Vec<_>>(),
        "results": results.iter().map(deck_result_from_row).collect::<Vec<_>>(),
        "players": players.iter().map(deck_player_from_row).collect::<Vec<_>>(),
        "decklists": decklists,
    })))
}

async fn fetch_decklist_detail(pool: &PgPool, id: &str) -> Res<Option<Value>> {
    if id.is_empty() {
        return Ok(None);
    }
    let mapping = has_blueprint_mapping_table(pool).await?;
    let mut detail = rows(pool, q::SQL_17, &[Bind::Text(id.to_owned())]).await?.into_iter().next();
    if detail.is_none() {
        detail = rows(pool, q::SQL_18, &[Bind::Text(id.to_owned())]).await?.into_iter().next();
    }
    let sql = q::SQL_19.replace("${JOIN}", &deck_card_image_join_sql("deck_card", "card_name", mapping));
    let cards = rows(pool, &sql, &[Bind::Text(id.to_owned())]).await?;
    if detail.is_none() && cards.is_empty() {
        return Ok(None);
    }
    let detail = detail.unwrap_or_else(|| json!({ "decklist_id": id }));
    Ok(Some(json!({
        "decklist": decklist_detail_from_row(&detail),
        "cards": cards.iter().map(deck_card_from_row).collect::<Vec<_>>(),
    })))
}

async fn fetch_summary(pool: &PgPool, game: Option<&str>, format: Option<&str>, year: Option<&str>) -> Res<Value> {
    let Filters { where_sql, values } = build_tournament_filters(game, format, year);
    let sql = q::SQL_20.replace("${where}", &where_sql);
    let row = rows(pool, &sql, &values).await?.into_iter().next().unwrap_or(json!({}));
    let public = rows(pool, q::SQL_21, &[]).await.unwrap_or_default().into_iter().next().unwrap_or(json!({}));
    Ok(json!({
        "tournamentCount": num0(&row, "tournament_count"),
        "totalPlayers": num0(&row, "total_players"),
        "tournamentsWithStandings": num0(&row, "standings_count"),
        "tournamentsWithPairings": num0(&row, "pairings_count"),
        "publicDeckCount": num0(&public, "deck_count"),
        "publicDeckPoints": num0(&public, "total_points"),
        "updatedAt": public.get("updated_at").filter(|v| js::truthy(Some(v))).or(row.get("updated_at").filter(|v| js::truthy(Some(v)))).cloned().unwrap_or(Value::Null),
    }))
}

const DETAIL_CACHE: &str = "public, max-age=30, s-maxage=180, stale-while-revalidate=300";

async fn respond(state: &RouteState, uri: &Uri) -> Result<Response, sqlx::Error> {
    let pool = state.api.read();
    let qs = http::Query::from_uri(uri);
    let p = |k: &str| qs.search_param(k);
    let decklist_id = clean_decklist_id_str(p("decklistId").unwrap_or(""));
    if !decklist_id.is_empty() {
        return Ok(match fetch_decklist_detail(pool, &decklist_id).await? {
            Some(detail) => http::json_with(StatusCode::OK, detail, &[("cache-control", DETAIL_CACHE)]),
            None => http::json(StatusCode::NOT_FOUND, json!({ "error": "Decklist not found." })),
        });
    }
    let deck_id = clean_deck_id(p("deckId"));
    if !deck_id.is_empty() {
        let limits = DeckLimits { result: p("resultLimit"), card: p("cardLimit"), player: p("playerLimit"), decklist: p("decklistLimit") };
        return Ok(match fetch_deck_detail(pool, &deck_id, limits).await? {
            Some(detail) => http::json_with(StatusCode::OK, detail, &[("cache-control", DETAIL_CACHE)]),
            None => http::json(StatusCode::NOT_FOUND, json!({ "error": "Deck not found." })),
        });
    }
    let tournament_id = clean_tournament_id(p("tournamentId"));
    if !tournament_id.is_empty() {
        let first = match fetch_tournament_snapshot(pool, &tournament_id, p("standingsLimit"), p("pairingsLimit")).await {
            Ok(v) => v,
            Err(error) if is_missing_public_limitless_table(&error) => None,
            Err(error) => return Err(error),
        };
        let snapshot = match first {
            Some(s) => Some(s),
            None => match fetch_public_tournament_snapshot(pool, &tournament_id, p("standingsLimit")).await {
                Ok(v) => v,
                Err(error) if is_missing_public_limitless_table(&error) => None,
                Err(error) => return Err(error),
            },
        };
        return Ok(match snapshot {
            Some(s) => http::json_with(StatusCode::OK, s, &[("cache-control", "public, max-age=30, s-maxage=120, stale-while-revalidate=300")]),
            None => http::json(StatusCode::NOT_FOUND, json!({ "error": "Tournament not found." })),
        });
    }
    let (game, format, year) = (p("game"), p("format"), p("year"));
    let games = async {
        if wants(p("includeGames")) { fetch_games(pool).await } else { Ok(Vec::new()) }
    };
    let (summary, games, years, tournaments, dashboard) = tokio::try_join!(
        fetch_summary(pool, game, format, year),
        games,
        fetch_years(pool, game, format),
        fetch_tournament_list(pool, game, format, year, p("limit")),
        fetch_dashboard(pool, game, format, year),
    )?;
    Ok(http::json_with(
        StatusCode::OK,
        json!({ "summary": summary, "games": games, "years": years, "tournaments": tournaments, "dashboard": dashboard }),
        &[("cache-control", DETAIL_CACHE)],
    ))
}

pub async fn handler(State(state): State<RouteState>, method: Method, uri: Uri) -> Response {
    let response = if method == Method::OPTIONS {
        with_headers(StatusCode::NO_CONTENT.into_response(), &[("allow", "GET, OPTIONS")])
    } else if method != Method::GET {
        http::json_with(StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "Method not allowed." }), &[("allow", "GET, OPTIONS")])
    } else {
        match respond(&state, &uri).await {
            Ok(response) => response,
            Err(error) => failed("marketplace-competitive", &error, "Marketplace competitive data failed."),
        }
    };
    with_headers(response, &CORS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleaners() {
        assert_eq!(clean_limit(None, 40, 120), 40);
        assert_eq!(clean_limit(Some("500"), 40, 120), 120);
        assert_eq!(clean_limit(Some("x"), 40, 120), 40);
        assert_eq!(clean_tournament_id(Some(" abc-12_/x ")), "abc-12_x");
        assert_eq!(clean_deck_id(Some("12a3")), "123");
        assert_eq!(clean_year(Some("2024")), Some(2024));
        assert_eq!(clean_year(None), None);
        assert_eq!(encode_uri_component("a b/c"), "a%20b%2Fc");
        let f = build_tournament_filters(Some("ptcg"), None, Some("2025"));
        assert_eq!(f.where_sql, "where true and t.game_id = $1 and t.tournament_date >= make_timestamptz($2, 1, 1, 0, 0, 0) and t.tournament_date < make_timestamptz($3, 1, 1, 0, 0, 0)");
    }
}
