//! Split a PowerTools all-games export using catalog Cardmarket product IDs.
//! Names and set codes are not game identifiers (and can collide across TCGs).

use std::collections::{BTreeMap, HashMap, HashSet};

use futures_util::{stream, StreamExt};
use serde_json::{json, Map, Value};

use crate::{db::DbPools, error::{ApiError, ApiResult}, powertools};

pub type GameIndex = HashMap<String, HashSet<String>>;
pub type SetNameIndex = HashMap<String, HashSet<String>>;

/// The registry is checked into the binary; request data never becomes SQL.
pub(crate) fn catalogs() -> Vec<(String, String)> {
    let games: Vec<Value> = serde_json::from_str(include_str!("ingest_games.json")).expect("game registry");
    let mut tables = vec![("pokemon".into(), "public.cardtrader_pokemon_blueprints".into())];
    tables.extend(games.iter().map(|g| (
        g["id"].as_str().unwrap().to_string(),
        format!("\"{}\".\"{}\"", g["schema"].as_str().unwrap(), g["table"].as_str().unwrap()),
    )));
    tables
}

pub fn catalog_sql(table: &str) -> String {
    format!("select distinct cm.id from {table} b
        cross join lateral jsonb_array_elements_text(
            case when jsonb_typeof(b.card_market_ids) = 'array'
                 then b.card_market_ids else '[]'::jsonb end
        ) cm(id) where cm.id = any($1::text[])")
}

pub fn expansion_name_sql(table: &str) -> String {
    format!(
        "select distinct b.expansion->>'name' as name from {table} b
         where b.expansion->>'name' = any($1::text[])
           and coalesce(b.expansion->>'name', '') <> ''"
    )
}

/// One bulk query per game, at most four at once, independent of CSV row count.
pub async fn game_index(db: &DbPools, ids: HashSet<String>) -> ApiResult<GameIndex> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let ids = json!(ids.into_iter().collect::<Vec<_>>());
    let results = stream::iter(catalogs().into_iter().map(|(game, table)| {
        let ids = ids.clone();
        async move {
            let rows = db.query(&game, &catalog_sql(&table), &[ids]).await;
            (game, rows)
        }
    }))
    .buffer_unordered(4)
    .collect::<Vec<_>>()
    .await;
    let mut index = GameIndex::new();
    for (game, result) in results {
        let rows = match result {
            Ok(rows) => rows,
            // Some registered games do not have a catalog yet.
            Err(error) if error.is_table_missing() => continue,
            Err(_) => return Err(ApiError::unavailable(format!(
                "Could not check the {game} catalog. Try analyzing the CSV again."
            ))
            .with_code("powertools_game_lookup")),
        };
        for row in rows {
            if let Some(id) = row["id"].as_str() {
                index.entry(id.to_string()).or_default().insert(game.clone());
            }
        }
    }
    Ok(index)
}

/// Exact expansion titles from catalog JSON — only when the CSV set column matches uniquely.
pub async fn set_name_index(db: &DbPools, names: HashSet<String>) -> ApiResult<SetNameIndex> {
    if names.is_empty() {
        return Ok(HashMap::new());
    }
    let names = json!(names.into_iter().collect::<Vec<_>>());
    let results = stream::iter(catalogs().into_iter().map(|(game, table)| {
        let names = names.clone();
        async move {
            let rows = db.query(&game, &expansion_name_sql(&table), &[names]).await;
            (game, rows)
        }
    }))
    .buffer_unordered(4)
    .collect::<Vec<_>>()
    .await;
    let mut index = SetNameIndex::new();
    for (game, result) in results {
        let rows = match result {
            Ok(rows) => rows,
            Err(error) if error.is_table_missing() => continue,
            Err(_) => return Err(ApiError::unavailable(format!(
                "Could not check the {game} catalog. Try analyzing the CSV again."
            ))
            .with_code("powertools_game_lookup")),
        };
        for row in rows {
            if let Some(name) = row["name"].as_str().filter(|s| !s.is_empty()) {
                index.entry(name.to_string()).or_default().insert(game.clone());
            }
        }
    }
    Ok(index)
}

pub fn read_mixed(text: &str) -> ApiResult<(Vec<String>, Vec<Map<String, Value>>)> {
    let (headers, records) = powertools::parse_csv(text);
    if !["cardmarketId", "quantity", "name"].iter().all(|h| headers.iter().any(|v| v == h)) {
        return Err(ApiError::bad_request("Use the PowerTools stock export with cardmarketId, quantity and name columns.")
            .with_code("powertools_csv"));
    }
    for (i, row) in records.iter().enumerate() {
        let quantity = row["quantity"].as_str().unwrap_or("").trim().parse::<f64>().unwrap_or(f64::NAN);
        if !quantity.is_finite() || quantity < 0.0 || quantity.fract() != 0.0 {
            return Err(ApiError::bad_request(format!("Line {}: quantity must be a non-negative whole number.", i + 2))
                .with_code("powertools_csv"));
        }
    }
    Ok((headers, records))
}

fn escape_csv_cell(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn cell_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

fn rows_to_csv(headers: &[String], rows: &[Value]) -> String {
    let mut lines = vec![headers.iter().map(|h| escape_csv_cell(h)).collect::<Vec<_>>().join(",")];
    for row in rows {
        lines.push(
            headers
                .iter()
                .map(|header| escape_csv_cell(&cell_string(row.get(header))))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    format!("{}\n", lines.join("\n"))
}

fn row_set_name(raw: &Map<String, Value>) -> String {
    raw.get("set")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn resolve_game(
    id: &str,
    set_name: &str,
    id_index: &GameIndex,
    set_index: &SetNameIndex,
) -> Result<String, &'static str> {
    match id_index.get(id) {
        Some(games) if games.len() == 1 => Ok(games.iter().next().cloned().unwrap()),
        Some(_) => Err("ambiguous_game"),
        None if set_name.is_empty() => Err("unknown_cardmarket_id"),
        None => match set_index.get(set_name) {
            Some(games) if games.len() == 1 => Ok(games.iter().next().cloned().unwrap()),
            Some(_) => Err("ambiguous_set_name"),
            None => Err("unknown_cardmarket_id"),
        },
    }
}

/// Pure partitioner, also used by the full-file verification test.
pub fn split_mixed(text: &str, id_index: &GameIndex, set_index: &SetNameIndex) -> ApiResult<(Value, Value)> {
    let (headers, records) = read_mixed(text)?;
    let mut by_game: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut skipped_zero = 0;
    let mut unresolved = Vec::new();
    let mut unresolved_count = 0;
    for (i, raw) in records.iter().enumerate() {
        let quantity = raw["quantity"].as_str().unwrap().trim().parse::<f64>().unwrap();
        if quantity == 0.0 {
            skipped_zero += 1;
            continue;
        }
        let id = raw["cardmarketId"].as_str().unwrap_or("").trim();
        let set_name = row_set_name(raw);
        match resolve_game(id, &set_name, id_index, set_index) {
            Ok(game) => {
                by_game.entry(game).or_default().push(Value::Object(raw.clone()));
            }
            Err(reason) => {
                unresolved_count += 1;
                if unresolved.len() < 20 {
                    unresolved.push(json!({
                        "line": i + 2,
                        "cardmarketId": id,
                        "name": raw["name"],
                        "set": if set_name.is_empty() { Value::Null } else { json!(set_name) },
                        "reason": reason,
                    }));
                }
            }
        }
    }
    let games: Vec<Value> = by_game
        .iter()
        .map(|(game, rows)| {
            json!({
                "id": game,
                "count": rows.len(),
                "quantity": rows
                    .iter()
                    .map(|r| r["quantity"].as_str().unwrap().trim().parse::<f64>().unwrap() as i64)
                    .sum::<i64>(),
            })
        })
        .collect();
    let files: Map<String, Value> = by_game
        .into_iter()
        .map(|(game, rows)| (game, json!(rows_to_csv(&headers, &rows))))
        .collect();
    Ok((
        Value::Object(files),
        json!({
            "games": games,
            "skippedZeroRows": skipped_zero,
            "unresolvedCount": unresolved_count,
            "unresolved": unresolved,
            "totalRows": records.len(),
        }),
    ))
}

fn mixed_prep(text: &str) -> ApiResult<(HashSet<String>, HashSet<String>)> {
    let (_, records) = read_mixed(text)?;
    let mut ids = HashSet::new();
    let mut set_names = HashSet::new();
    for raw in &records {
        let quantity = raw["quantity"].as_str().unwrap().trim().parse::<f64>().unwrap();
        if quantity == 0.0 {
            continue;
        }
        if let Some(id) = raw["cardmarketId"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
            ids.insert(id.to_string());
        }
        let set_name = row_set_name(raw);
        if !set_name.is_empty() {
            set_names.insert(set_name);
        }
    }
    Ok((ids, set_names))
}

/// Backwards compatible with `{pokemon: csv, ...}`. The Solid uploader sends
/// `{auto: csv}` for a single mixed file; both preview and import resolve it here.
pub async fn resolve_body(db: &DbPools, mut body: Value) -> ApiResult<(Value, Value)> {
    let Some(text) = body
        .pointer("/powerToolsCsv/auto")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
    else {
        return Ok((body, Value::Null));
    };
    if body["powerToolsCsv"].as_object().map_or(0, Map::len) != 1 {
        return Err(ApiError::bad_request("Upload either one all-games CSV or separate files per game."));
    }
    let text = text.to_string();
    let (ids, set_names) = tokio::task::spawn_blocking(move || mixed_prep(&text))
        .await
        .map_err(|_| ApiError::new(500, "Power Tools CSV processing failed."))??;
    let id_index = game_index(db, ids).await?;
    let set_index = set_name_index(db, set_names).await?;
    let text = body
        .pointer("/powerToolsCsv/auto")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    let (files, detection) = tokio::task::spawn_blocking(move || split_mixed(&text, &id_index, &set_index))
        .await
        .map_err(|_| ApiError::new(500, "Power Tools CSV processing failed."))??;
    body["powerToolsCsv"] = files;
    Ok((body, detection))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixed_export_splits_six_games_preserves_locations_and_skips_zero_stock() {
        let games = ["pokemon", "magic", "yugioh", "dragon_ball_super", "one_piece", "riftbound"];
        let mut id_index = GameIndex::new();
        let set_index = SetNameIndex::new();
        let mut csv = "cardmarketId,quantity,name,location,finishType\r\n".to_string();
        for (i, game) in games.iter().enumerate() {
            id_index.insert(i.to_string(), [game.to_string()].into_iter().collect());
            csv.push_str(&format!("{i},2,\"Card, {i}\",\"Box, A - 01\",Foil\r\n"));
        }
        csv.push_str("999,0,Empty,Old box,Regular\r\n998,1,Unknown,Box B,Regular\r\n");
        let (files, detection) = split_mixed(&csv, &id_index, &set_index).unwrap();
        assert_eq!(files.as_object().unwrap().len(), 6);
        assert_eq!(detection["skippedZeroRows"], 1);
        assert_eq!(detection["unresolvedCount"], 1);
        assert_eq!(detection["unresolved"][0]["line"], 9);
        for game in games {
            let (_, rows) = powertools::parse_csv(files[game].as_str().unwrap());
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["location"], "Box, A - 01");
            assert_eq!(rows[0]["finishType"], "Foil");
        }
    }

    #[test]
    fn never_guesses_ambiguous_ids_or_missing_quantities() {
        let id_index = [("1".into(), ["pokemon".into(), "magic".into()].into_iter().collect())]
            .into_iter()
            .collect();
        let set_index = [("Shared Set".into(), ["pokemon".into()].into_iter().collect())]
            .into_iter()
            .collect();
        let (files, detection) = split_mixed(
            "cardmarketId,quantity,name,set\n1,1,Pikachu,Shared Set\n",
            &id_index,
            &set_index,
        )
        .unwrap();
        assert!(files.as_object().unwrap().is_empty());
        assert_eq!(detection["unresolved"][0]["reason"], "ambiguous_game");
        for qty in ["", "-1", "1.5", "NaN"] {
            assert!(split_mixed(
                &format!("cardmarketId,quantity,name\n1,{qty},Pikachu\n"),
                &id_index,
                &set_index,
            )
            .is_err());
        }
        assert!(split_mixed("name,quantity\nPikachu,1\n", &id_index, &set_index).is_err());
    }

    #[test]
    fn set_name_fallback_only_when_id_unknown_and_unique() {
        let id_index = GameIndex::new();
        let set_index = [("Mirrodin".into(), ["magic".into()].into_iter().collect())]
            .into_iter()
            .collect();
        let (files, detection) = split_mixed(
            "cardmarketId,quantity,name,set\n999,1,Card, Mirrodin,Mirrodin\n",
            &id_index,
            &set_index,
        )
        .unwrap();
        assert_eq!(detection["unresolvedCount"], 0);
        assert_eq!(files.as_object().unwrap().len(), 1);
        assert!(files.get("magic").is_some());

        let ambiguous_set = [(
            "Twin Set".into(),
            ["pokemon".into(), "magic".into()].into_iter().collect(),
        )]
        .into_iter()
        .collect();
        let (_, detection) = split_mixed(
            "cardmarketId,quantity,name,set\n1,1,Card,Twin Set,Twin Set\n",
            &id_index,
            &ambiguous_set,
        )
        .unwrap();
        assert_eq!(detection["unresolved"][0]["reason"], "ambiguous_set_name");
    }

    #[test]
    fn id_match_wins_over_set_name() {
        let id_index = [("42".into(), ["pokemon".into()].into_iter().collect())]
            .into_iter()
            .collect();
        let set_index = [("Mirrodin".into(), ["magic".into()].into_iter().collect())]
            .into_iter()
            .collect();
        let (files, _) = split_mixed(
            "cardmarketId,quantity,name,set\n42,1,Pika,Mirrodin,Mirrodin\n",
            &id_index,
            &set_index,
        )
        .unwrap();
        assert!(files.get("pokemon").is_some());
        assert!(files.get("magic").is_none());
    }

    #[test]
    fn does_not_route_unknown_rows_to_pokemon() {
        let (files, detection) = split_mixed(
            "cardmarketId,quantity,name,set\n404,1,Orphan,Nowhere,\n",
            &GameIndex::new(),
            &SetNameIndex::new(),
        )
        .unwrap();
        assert!(files.as_object().unwrap().is_empty());
        assert_eq!(detection["unresolvedCount"], 1);
        assert_eq!(detection["unresolved"][0]["reason"], "unknown_cardmarket_id");
    }
}
