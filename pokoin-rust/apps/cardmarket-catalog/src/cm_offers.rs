//! Cardmarket offer minima as the CTCMDeals worker captured them
//! (`worker/data/cm_offers/minimums.jsonl` or the `latest.json` index).
//!
//! One record is one facet of one product: the cheapest offer seen behind
//! Cardmarket's `minCondition`, language, `isReverseHolo`, `isFirstEd` and
//! seller-type filters, at a moment in time. The record's `condition` is the
//! *worst* grade the filter accepts, so an `NM` facet holds NM-or-better
//! offers only, and a `*` facet holds a mix of whatever the filter was not
//! set to. `min_cents` is EUR cents.
//!
//! Nothing here is derived: a record without a usable product id, a known
//! facet code, a real price or a parseable observation time is skipped and
//! counted, never guessed at. Facets that found no offers hold a null
//! `minCents` and are skipped with them — that answer belongs to the engine's
//! own store, not to a price table.

use serde_json::Value;

/// One settled facet minimum, as observed.
#[derive(Clone, Debug, PartialEq)]
pub struct Minimum {
    pub id_product: i64,
    /// Pokoin's language key of Cardmarket's facet, or `*`.
    pub language: String,
    /// `NM`, `SP`, `MP`, `PL`, `Poor` or `*`.
    pub condition: String,
    /// `Y`, `N` or `*`: Pokémon reverse holo, other games' foil.
    pub finish: String,
    pub first_edition: String,
    /// `pro` or `private`.
    pub seller_type: String,
    pub min_cents: i64,
    pub offers: Option<i64>,
    pub counts_complete: Option<bool>,
    /// RFC 3339, as the engine wrote it; Postgres reads it as `timestamptz`.
    pub observed_at: String,
}

/// Cardmarket's facet conditions, in the engine's spelling. `Poor` is its own
/// bucket; the others are one letter.
const CONDITIONS: [&str; 6] = ["NM", "SP", "MP", "PL", "Poor", "*"];

/// Cardmarket's language facet codes mapped to the key the pricer matches
/// listings with. The engine writes Cardmarket's own `ZH-TW`; Pokoin's
/// `language_key` calls Traditional Chinese `ZHT`, and a floor that never
/// joins is a floor that never happens.
const LANGUAGES: [(&str, &str); 14] = [
    ("EN", "EN"),
    ("FR", "FR"),
    ("DE", "DE"),
    ("ES", "ES"),
    ("IT", "IT"),
    ("ZH", "ZH"),
    ("JP", "JP"),
    ("PT", "PT"),
    ("RU", "RU"),
    ("KO", "KO"),
    ("ZH-TW", "ZHT"),
    ("NL", "NL"),
    ("PL", "PL"),
    ("*", "*"),
];

const FLAGS: [&str; 3] = ["Y", "N", "*"];
const SELLER_TYPES: [&str; 2] = ["pro", "private"];

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(|s| s.trim().to_string())
}

fn product_id(value: &Value) -> Option<i64> {
    let raw = match value.get("idProduct") {
        Some(Value::Number(_)) => value.get("idProduct")?.as_i64(),
        Some(Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    };
    raw.filter(|id| *id > 0)
}

fn condition_key(raw: &str) -> Option<String> {
    CONDITIONS
        .iter()
        .find(|c| c.eq_ignore_ascii_case(raw))
        .map(|c| (*c).to_string())
}

fn language_key(raw: &str) -> Option<String> {
    LANGUAGES
        .iter()
        .find(|(code, _)| code.eq_ignore_ascii_case(raw))
        .map(|(_, key)| (*key).to_string())
}

fn cents(value: Option<&Value>) -> Option<i64> {
    match value? {
        // A fraction is not a price Cardmarket showed; it is a bug or a
        // different currency's rounding, so it does not become one here.
        Value::Number(number) => {
            let cents = number.as_i64()?;
            (cents >= 0).then_some(cents)
        }
        _ => None,
    }
}

fn count(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => number.as_i64().filter(|n| *n >= 0),
        _ => None,
    }
}

fn observed_at(value: &Value) -> Option<String> {
    let text = value.get("observedAt").and_then(Value::as_str)?;
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|_| text.to_string())
}

/// One record of the log, or `None` when it is not a usable price for a known
/// facet.
fn record(value: &Value) -> Option<Minimum> {
    let id_product = product_id(value)?;
    let language = value.get("language").and_then(Value::as_str).map(language_key)??;
    let condition = value.get("condition").and_then(Value::as_str).map(condition_key)??;
    let upper = |key: &str| {
        text(value, key)
            .map(|v| v.to_ascii_uppercase())
            .filter(|v| FLAGS.contains(&v.as_str()))
    };
    let finish = upper("finish")?;
    let first_edition = upper("firstEdition")?;
    let seller_type = text(value, "seller_type")
        .or_else(|| text(value, "sellerType"))?
        .to_ascii_lowercase();
    if !SELLER_TYPES.contains(&seller_type.as_str()) {
        return None;
    }
    let min_cents = cents(value.get("minCents"))?;
    let observed_at = observed_at(value)?;
    Some(Minimum {
        id_product,
        language,
        condition,
        finish,
        first_edition,
        seller_type,
        min_cents,
        offers: count(value.get("count")),
        counts_complete: value.get("countsComplete").and_then(Value::as_bool),
        observed_at,
    })
}

/// The facet key the table is unique on.
pub fn facet_key(minimum: &Minimum) -> String {
    [
        minimum.id_product.to_string(),
        minimum.language.clone(),
        minimum.condition.clone(),
        minimum.finish.clone(),
        minimum.first_edition.clone(),
        minimum.seller_type.clone(),
    ]
    .join("|")
}

/// Read the engine's output: the append-only `minimums.jsonl` (one record per
/// line), the `latest.json` facet map, a bare array of records, or one record.
/// A facet observed twice keeps the newer observation, since the table holds
/// one row per facet. Returns the records and how many were skipped.
pub fn parse_minimums(text: &str) -> Result<(Vec<Minimum>, usize), String> {
    let values: Vec<Value> = match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(items)) => items.clone(),
        Ok(Value::Object(map)) => {
            if map.contains_key("idProduct") {
                vec![Value::Object(map)]
            } else {
                map.values().filter(|v| v.is_object()).cloned().collect()
            }
        }
        Ok(_) => return Err("input is not a record, an array or a facet map".into()),
        Err(whole) => {
            let mut items = Vec::new();
            for (number, line) in text.lines().enumerate() {
                if line.trim().is_empty() {
                    continue;
                }
                let value = serde_json::from_str::<Value>(line)
                    .map_err(|e| format!("line {}: {e} (as a whole file: {whole})", number + 1))?;
                items.push(value);
            }
            items
        }
    };
    let mut newest: Vec<(String, Minimum)> = Vec::new();
    let mut skipped = 0usize;
    for value in values {
        match record(&value) {
            Some(minimum) => {
                let key = facet_key(&minimum);
                match newest.iter().position(|(k, _)| *k == key) {
                    Some(at) => {
                        if newest[at].1.observed_at < minimum.observed_at {
                            newest[at].1 = minimum;
                        }
                    }
                    None => newest.push((key, minimum)),
                }
            }
            None => skipped += 1,
        }
    }
    newest.sort_by(|a, b| a.0.cmp(&b.0));
    Ok((newest.into_iter().map(|(_, m)| m).collect(), skipped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Dialga (Call of Legends CL3, idProduct 279646) as the live 2026-11-10
    /// harvest recorded it.
    const DIALGA: &str = r#"{"observedAt":"2026-11-10T13:09:30.235Z","id":"279646-IT-NM","idProduct":279646,"condition":"NM","language":"IT","finish":"*","firstEdition":"*","sellerType":"private","minCents":1000,"count":2,"countsComplete":true,"status":"ok","pages":1}
{"observedAt":"2026-11-10T13:09:30.235Z","id":"279646-IT-NM","idProduct":279646,"condition":"NM","language":"IT","finish":"*","firstEdition":"*","sellerType":"pro","minCents":2000,"count":1,"countsComplete":true,"status":"ok","pages":1}
{"observedAt":"2026-11-10T13:09:30.235Z","id":"279646-IT-SP","idProduct":279646,"condition":"SP","language":"IT","finish":"*","firstEdition":"*","sellerType":"private","minCents":300,"count":10,"countsComplete":true,"status":"ok","pages":1}
{"observedAt":"2026-11-10T13:09:30.235Z","id":"279646-IT-SP","idProduct":279646,"condition":"SP","language":"IT","finish":"*","firstEdition":"*","sellerType":"pro","minCents":588,"count":4,"countsComplete":true,"status":"ok","pages":1}
"#;

    fn record_json(over: Value) -> Value {
        let mut base = json!({"observedAt": "2026-11-10T13:09:30.235Z", "idProduct": 279646,
                              "condition": "NM", "language": "IT", "finish": "N",
                              "firstEdition": "N", "sellerType": "pro", "minCents": 2000,
                              "count": 1, "countsComplete": true, "status": "ok"});
        for (key, value) in over.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    }

    #[test]
    fn a_live_harvest_loads_every_facet_it_recorded() {
        let (minimums, skipped) = parse_minimums(DIALGA).unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(minimums.len(), 4);
        let pro_nm = minimums
            .iter()
            .find(|m| m.seller_type == "pro" && m.condition == "NM")
            .unwrap();
        assert_eq!(
            *pro_nm,
            Minimum {
                id_product: 279646,
                language: "IT".into(),
                condition: "NM".into(),
                finish: "*".into(),
                first_edition: "*".into(),
                seller_type: "pro".into(),
                min_cents: 2000,
                offers: Some(1),
                counts_complete: Some(true),
                observed_at: "2026-11-10T13:09:30.235Z".into(),
            }
        );
        // €20.00 from a professional seller, and €5.88 of the SP-or-better one.
        assert_eq!(pro_nm.min_cents * 2, 4000);
        assert_eq!(
            minimums
                .iter()
                .find(|m| m.seller_type == "pro" && m.condition == "SP")
                .unwrap()
                .min_cents,
            588
        );
    }

    #[test]
    fn the_latest_index_and_a_bare_array_load_like_the_log() {
        let (minimums, skipped) = parse_minimums(DIALGA).unwrap();
        let records: Vec<Value> = minimums
            .iter()
            .map(|m| record_json(json!({"condition": m.condition, "sellerType": m.seller_type, "minCents": m.min_cents})))
            .collect();
        let (from_array, _) = parse_minimums(&serde_json::to_string(&records).unwrap()).unwrap();
        assert_eq!(from_array.len(), 4);
        assert_eq!(skipped, 0);
        let latest = json!({"279646|IT|*|*|NM|pro": records[0], "279646|IT|*|*|NM|private": records[1]});
        let (from_map, skipped) = parse_minimums(&serde_json::to_string(&latest).unwrap()).unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(from_map.len(), 2);
        assert_eq!(from_map[0].seller_type, "private");
        let (one, skipped) = parse_minimums(&serde_json::to_string(&records[0]).unwrap()).unwrap();
        assert_eq!((one.len(), skipped), (1, 0));
    }

    #[test]
    fn cardmarkets_own_traditional_chinese_code_becomes_pokoin_key() {
        let (minimums, skipped) =
            parse_minimums(&serde_json::to_string(&[record_json(json!({"language": "ZH-TW"}))]).unwrap())
                .unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(minimums[0].language, "ZHT");
    }

    #[test]
    fn facet_codes_are_the_engine_spelling_not_a_guess() {
        for (value, key, want) in [
            (json!("nm"), "condition", "NM"),
            (json!("Poor"), "condition", "Poor"),
            (json!("y"), "finish", "Y"),
            (json!("n"), "firstEdition", "N"),
            (json!("Pro"), "sellerType", "pro"),
            (json!("it"), "language", "IT"),
        ] {
            let over = json!({key: value});
            let (minimums, skipped) =
                parse_minimums(&serde_json::to_string(&[record_json(over)]).unwrap()).unwrap();
            assert_eq!(skipped, 0, "{key} {value}");
            assert_eq!(minimums.len(), 1, "{key} {value}");
            match key {
                "sellerType" => assert_eq!(minimums[0].seller_type, want, "{value}"),
                "language" => assert_eq!(minimums[0].language, want, "{value}"),
                "condition" => assert_eq!(minimums[0].condition, want, "{value}"),
                "finish" => assert_eq!(minimums[0].finish, want, "{value}"),
                _ => assert_eq!(minimums[0].first_edition, want, "{value}"),
            }
        }
    }

    #[test]
    fn unknown_facet_codes_are_skipped_not_stored() {
        for over in [
            json!({"condition": "Mint"}),
            json!({"language": "KR"}),
            json!({"finish": "true"}),
            json!({"firstEdition": "yes"}),
            json!({"sellerType": "powerseller"}),
            json!({"sellerType": null}),
            json!({"idProduct": 0}),
            json!({"idProduct": -1}),
            json!({"idProduct": null}),
            json!({"observedAt": "yesterday"}),
            json!({"observedAt": null}),
        ] {
            let (minimums, skipped) =
                parse_minimums(&serde_json::to_string(&[record_json(over.clone())]).unwrap()).unwrap();
            assert!(minimums.is_empty(), "stored {minimums:?} for {over}");
            assert_eq!(skipped, 1, "{over}");
        }
    }

    #[test]
    fn a_facet_that_found_no_offers_is_not_a_price() {
        for over in [
            json!({"minCents": null}),
            json!({"minCents": -1}),
            json!({"minCents": 19.99}),
            json!({"minCents": "20,00"}),
            json!({"minCents": null, "status": "error", "error": "fetch failed"}),
        ] {
            let (minimums, skipped) =
                parse_minimums(&serde_json::to_string(&[record_json(over.clone())]).unwrap()).unwrap();
            assert!(minimums.is_empty(), "stored {minimums:?} for {over}");
            assert_eq!(skipped, 1, "{over}");
        }
    }

    #[test]
    fn an_unreliable_count_and_a_broken_offer_count_stay_null() {
        let (minimums, _) = parse_minimums(
            &serde_json::to_string(&[record_json(json!({"count": null, "countsComplete": false}))])
                .unwrap(),
        )
        .unwrap();
        assert_eq!((minimums[0].offers, minimums[0].counts_complete), (None, Some(false)));
        let (minimums, _) = parse_minimums(
            &serde_json::to_string(&[record_json(json!({"count": -3, "countsComplete": "yes"}))]).unwrap(),
        )
        .unwrap();
        assert_eq!((minimums[0].offers, minimums[0].counts_complete), (None, None));
        assert_eq!(minimums[0].min_cents, 2000);
    }

    #[test]
    fn a_re_observed_facet_keeps_the_newer_observation_once() {
        let older = record_json(json!({"minCents": 2000, "observedAt": "2026-11-01T09:00:00.000Z"}));
        let newer = record_json(json!({"minCents": 1850, "observedAt": "2026-11-10T13:09:30.235Z"}));
        let (minimums, skipped) =
            parse_minimums(&serde_json::to_string(&[older.clone(), newer]).unwrap()).unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(minimums.len(), 1);
        assert_eq!(minimums[0].min_cents, 1850);
        assert_eq!(minimums[0].observed_at, "2026-11-10T13:09:30.235Z");
        // The same facet twice in a file in either order answers the same.
        let (minimums, _) = parse_minimums(
            &serde_json::to_string(&[
                record_json(json!({"minCents": 1850, "observedAt": "2026-11-10T13:09:30.235Z"})),
                older,
            ])
            .unwrap(),
        )
        .unwrap();
        assert_eq!(minimums[0].min_cents, 1850);
    }

    #[test]
    fn a_string_product_id_and_a_blank_line_are_fine() {
        let text = format!(
            "\n{}\n\n",
            serde_json::to_string(&record_json(json!({"idProduct": "279259"}))).unwrap()
        );
        let (minimums, skipped) = parse_minimums(&text).unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(minimums[0].id_product, 279259);
    }

    #[test]
    fn a_broken_line_is_an_error_not_a_quiet_skip() {
        let text = format!("{}{{\"idProduct\": broken\n", DIALGA);
        let error = parse_minimums(&text).unwrap_err();
        assert!(error.contains("line 5"), "{error}");
    }

    #[test]
    fn text_input_is_an_error() {
        assert!(parse_minimums("\"nope\"").is_err());
    }
}
