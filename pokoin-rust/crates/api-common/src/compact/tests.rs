//! Round-trip tests: `decode(encode(body))` must serialise to exactly the same
//! bytes as `body`, for every shape the target routes produce.

use serde_json::{json, Value};

use super::{decode, encode, Wanted};

/// The contract: the default JSON is byte-for-byte unchanged after a round trip.
#[track_caller]
fn assert_round_trips(body: &Value) -> usize {
    let document = encode::encode(body);
    let decoded = decode::decode(&document).expect("c1 document decodes");
    let expected = serde_json::to_string(body).expect("default json");
    let actual = serde_json::to_string(&decoded).expect("decoded json");
    assert_eq!(actual, expected, "c1 round trip changed the body");
    serde_json::to_string(&document).expect("c1 json").len()
}

#[track_caller]
fn assert_smaller(body: &Value) {
    let default = serde_json::to_string(body).expect("default json").len();
    let compact = assert_round_trips(body);
    assert!(
        compact < default,
        "c1 ({compact} bytes) is not smaller than the default ({default} bytes)"
    );
}

fn card(index: u64) -> Value {
    let id = 668_000 + index;
    let stem = format!("{id}_levincia");
    json!({
        "id": id.to_string(),
        "card_id": id.to_string(),
        "name": "Levincia",
        "set": "Destined Rivals",
        "set_name": "Destined Rivals",
        "number": format!("Gold Secret Rare | {}/182", 240 + index),
        "card_number": format!("Gold Secret Rare | {}/182", 240 + index),
        "rarity": "Gold Secret Rare",
        "rarityKind": "gold",
        "itemKind": "single",
        "productType": "card",
        "canonicalPath": format!("/marketplace/en/cards/{id}/card-levincia-destined-rivals"),
        "canonical_path": format!("/marketplace/en/cards/{id}/card-levincia-destined-rivals"),
        "artist": "MARINA Chikazawa",
        "illustrator": "MARINA Chikazawa",
        "cardIdentityEmoji": "",
        "cardIdentityEmojis": [],
        "emoji": "🏆",
        "artLayout": "bleed",
        "art_layout": "bleed",
        "nationality": "western",
        "versionCount": Value::Null,
        "imageUrl": format!("/card-images/{stem}.jpg"),
        "previewImageUrl": format!("/card-images/previews/{stem}.jpg"),
        "homepageImageUrl": format!("/card-images/{stem}_homepage.webp"),
        "gridImageUrl": format!("/card-images/{stem}.jpg"),
        "tileImageUrl": format!("/card-images/{stem}_homepage.webp"),
        "price": 1426 + index,
        "stock": 102 - index,
        "hasCardTraderListing": true,
        "isMarketAvailable": true,
    })
}

fn expansion_page(rows: u64) -> Value {
    json!({
        "expansion": {
            "name": "Destined Rivals",
            "slug": "destined-rivals",
            "symbolImageUrl": "https://cdn.pokoin.com/expansions/symbols/destined-rivals.png",
            "logoImageUrl": "https://cdn.pokoin.com/expansions/logos/destined-rivals.png",
            "cardCount": 244,
            "nationality": "western",
        },
        "cards": (0..rows).map(card).collect::<Vec<Value>>(),
        "productType": "card",
        "limit": 200,
        "offset": 0,
        "count": rows,
        "total": 244,
        "hasMore": true,
    })
}

#[test]
fn an_expansion_page_round_trips_and_shrinks() {
    assert_smaller(&expansion_page(60));
}

#[test]
fn aliased_and_derived_columns_collapse() {
    let body = expansion_page(60);
    let document = encode::encode(&body);
    let columns = document["t"][0]["c"].as_array().expect("columns");
    let keys: Vec<&str> = document["t"][0]["k"]
        .as_array()
        .expect("keys")
        .iter()
        .map(|key| key.as_str().unwrap_or_default())
        .collect();
    let column = |name: &str| {
        let index = keys.iter().position(|key| *key == name).expect(name);
        &columns[index]
    };
    // Alias pairs are references, not second copies.
    for alias in [
        "card_id",
        "card_number",
        "canonical_path",
        "gridImageUrl",
        "tileImageUrl",
    ] {
        assert_eq!(column(alias)["c"], json!(4), "{alias} should be a ref");
    }
    // Alias pairs whose value is the same on every row are constants instead,
    // which is smaller still.
    for alias in ["set_name", "illustrator", "art_layout"] {
        assert_eq!(column(alias)["c"], json!(0), "{alias} should be a const");
    }
    // The derived image URLs share one stored array via prefix/suffix stripping.
    assert_eq!(column("previewImageUrl")["c"], json!(4));
    assert_eq!(column("homepageImageUrl")["c"], json!(4));
    // Constant columns are stored once.
    assert_eq!(column("name")["c"], json!(0));
    assert_eq!(column("rarity")["c"], json!(0));
    // The id column is a delta of integers behind `ns`.
    assert_eq!(column("id")["c"], json!(3));
    assert_eq!(column("id")["ns"], json!(1));
}

#[test]
fn a_dictionary_coded_column_uses_codes() {
    // Enough distinct values that a palette beats the raw array, and all of
    // them in the nationalities table.
    let rows: Vec<Value> = (0..40)
        .map(|index| {
            let nationality = ["western", "japanese", "chinese"][index % 3];
            json!({ "nationality": nationality })
        })
        .collect();
    let body = json!({"cards": rows});
    let document = encode::encode(&body);
    let column = &document["t"][0]["c"][0];
    assert_eq!(column["c"], json!(2));
    assert_eq!(column["t"], json!("nationalities"));
    assert_eq!(column["p"], json!([1, 2, 4]));
    assert_round_trips(&body);
}

#[test]
fn search_page_and_home_page_shapes_round_trip() {
    assert_smaller(&json!({
        "query": "charizard",
        "game": "pokemon",
        "productType": "",
        "lang": "en",
        "limit": 100,
        "offset": 0,
        "count": 40,
        "total": 706,
        "hasMore": true,
        "cards": (0..40).map(card).collect::<Vec<Value>>(),
        "facets": {"products": [
            {"productType": "card", "count": 706},
            {"productType": "accessory", "count": 96},
            {"productType": "collection_box", "count": 31},
            {"productType": "tin", "count": 12},
        ]},
    }));
    assert_smaller(&json!({
        "source": "snapshot",
        "cacheTtl": 60,
        "pknUsdt": 0.0123,
        "cards": (0..40).map(card).collect::<Vec<Value>>(),
        "sections": {
            "recentlySeenIds": [],
            "bestSellerIds": (0..12).map(|i| (612_454 + i).to_string()).collect::<Vec<String>>(),
            "featuredIds": (0..30).map(|i| (813_528 + i * 7).to_string()).collect::<Vec<String>>(),
        },
        "game": "pokemon",
    }));
}

#[test]
fn awkward_values_round_trip() {
    // Absent keys, mixed types in one column, nested arrays and objects,
    // unicode, floats, nulls, negative and large integers, empty containers.
    assert_round_trips(&json!({
        "rows": [
            {"a": 1, "b": null, "deep": {"x": [1, 2, {"y": "ü"}]}},
            {"a": "1", "deep": {}},
            {"a": -9_007_199_254_740_991i64, "b": 1.5, "c": false},
            {"a": 0.1, "b": "", "c": true, "extra": []},
            {"a": "0", "b": "007", "c": "𝛑"},
            {"a": 9_007_199_254_740_991i64},
            {},
            {"a": {"nested": "object"}, "b": [[]]},
        ],
    }));
}

#[test]
fn documents_that_are_not_tables_round_trip() {
    assert_round_trips(&json!({"error": "Expansion not found.", "slug": "nope"}));
    assert_round_trips(&json!([]));
    assert_round_trips(&json!(null));
    assert_round_trips(&json!("a bare string"));
    assert_round_trips(&json!(7));
    assert_round_trips(&json!([{"a": 1}, {"a": 2}]));
    assert_round_trips(&json!({"c1": 1, "b": "a body-shaped payload", "t": []}));
}

#[test]
fn a_payload_that_already_uses_the_marker_key_round_trips() {
    assert_round_trips(&json!({"$c1": 3, "other": 1}));
    assert_round_trips(&json!({"$c1x": {"$c1": 3}}));
    assert_round_trips(&json!([{"$c1": 1, "k": 1}, {"$c1": 2, "k": 2}, {"$c1": 3, "k": 3}, {"$c1": 4, "k": 4}]));
}

#[test]
fn the_document_declares_its_versions() {
    let document = encode::encode(&expansion_page(8));
    assert_eq!(document["c1"], json!(encode::FORMAT_VERSION));
    assert_eq!(document["dict"], json!(super::dict::VERSION));
}

#[test]
fn a_column_is_never_larger_than_the_plain_array() {
    // Unsorted integers, high-cardinality strings and random floats are the
    // cases where delta or a palette could backfire.
    let rows: Vec<Value> = (0..50)
        .map(|index: i64| {
            json!({
                "jumpy": (index * 7919) % 1021,
                "unique": format!("{index}-{}", (index * 31) % 97),
                "float": index as f64 * 0.37,
            })
        })
        .collect();
    let body = json!({"rows": rows});
    assert_round_trips(&body);
    let document = encode::encode(&body);
    for (index, column) in document["t"][0]["c"]
        .as_array()
        .expect("columns")
        .iter()
        .enumerate()
    {
        let plain: Vec<Value> = rows
            .iter()
            .map(|row| row[["jumpy", "unique", "float"][index]].clone())
            .collect();
        let plain = serde_json::to_string(&json!({"c": 1, "v": plain}))
            .expect("plain")
            .len();
        let actual = serde_json::to_string(column).expect("column").len();
        assert!(actual <= plain, "column {index}: {actual} > {plain}");
    }
}

#[test]
fn responses_carry_vary_accept_in_both_representations() {
    let body = expansion_page(8);
    let default = super::json_ok(Wanted::DEFAULT, body.clone(), "public, max-age=30");
    assert_eq!(default.headers()["vary"], "Accept");
    assert_eq!(
        default.headers()["content-type"],
        "application/json; charset=utf-8"
    );
    assert_eq!(default.headers()["cache-control"], "public, max-age=30");

    let compact = super::json_ok(
        Wanted::from_parts(Some(super::C1_MEDIA_TYPE), ""),
        body,
        "public, max-age=30",
    );
    assert_eq!(compact.headers()["vary"], "Accept");
    assert_eq!(compact.headers()["content-type"], super::C1_CONTENT_TYPE);
    assert_eq!(compact.headers()["cache-control"], "public, max-age=30");
    assert_eq!(compact.status(), default.status());
}

#[test]
fn an_infrastructure_error_is_sanitised_in_both_representations() {
    let body = json!({"error": "connect ECONNREFUSED 127.0.0.1:5432"});
    for wanted in [Wanted::DEFAULT, Wanted::from_parts(None, "format=c1")] {
        let response = super::json_with_cors(
            wanted,
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            body.clone(),
            "no-store",
        );
        assert_eq!(
            response.status(),
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        );
    }
}

/// A set page shaped like production rows: `canonicalPath` and the image URLs
/// are built from `id`, `name`, `number` and `set`; `canonical_path` is a twin;
/// one optional key; a few rows break the pattern.
fn templated_page() -> Value {
    let names = ["Levincia", "Mega Lucario ex", "Pikachu", "Team Rocket\u{2019}s Mewtwo", "N\u{2019}s Zekrom", "Ho-Oh"];
    let cards: Vec<Value> = (0..24)
        .map(|i| {
            let id = 668_100 + i * 3;
            let name = names[i as usize % names.len()];
            let number = format!("Holo Rare | {:03}/182", i + 1);
            let slug = |s: &str| super::template::slug(s);
            let path = if i % 11 == 7 {
                format!("/marketplace/en/cards/{id}/legacy-{i}")
            } else {
                format!("/marketplace/en/cards/{id}/card-{}-{}-destined-rivals", slug(name), slug(&number))
            };
            let mut row = json!({
                "id": id.to_string(),
                "name": name,
                "number": number,
                "set": "Destined Rivals",
                "canonicalPath": path,
                "canonical_path": path,
                "imageUrl": format!("/card-images/{id}_{}.jpg", slug(name)),
            });
            if i % 3 == 0 {
                row["artist"] = json!(format!("Artist {}", i % 4));
            }
            row
        })
        .collect();
    json!({"cards": cards, "total": 24})
}

#[test]
fn templates_round_trip_and_mark_format_two() {
    let body = templated_page();
    let options = encode::EncodeOptions { templates: true };
    let document = encode::encode_with(&body, options);
    assert_eq!(document["c1"], json!(2));
    let decoded = decode::decode(&document).expect("c1v2 decodes");
    assert_eq!(serde_json::to_string(&decoded).unwrap(), serde_json::to_string(&body).unwrap());
    let columns = document["t"][0]["c"].as_array().unwrap();
    let keys: Vec<&str> = document["t"][0]["k"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
    let at = |key: &str| &columns[keys.iter().position(|k| *k == key).unwrap()];
    assert_eq!(at("canonicalPath")["c"], json!(5));
    // The twin refs the template instead of repeating it.
    assert_eq!(at("canonical_path")["c"], json!(4));
    // v2 is smaller than v1 on this shape.
    let v1 = serde_json::to_vec(&encode::encode(&body)).unwrap().len();
    let v2 = serde_json::to_vec(&document).unwrap().len();
    assert!(v2 < v1, "v2 {v2} >= v1 {v1}");
}

#[test]
fn without_templates_the_document_stays_format_one() {
    let body = templated_page();
    let document = encode::encode(&body);
    assert_eq!(document["c1"], json!(1));
    assert!(!serde_json::to_string(&document).unwrap().contains("\"c\":5"));
    let options = encode::EncodeOptions { templates: true };
    // Nothing worth templating: still format 1.
    let small = json!({"rows": [{"a": 1}, {"a": 2}, {"a": 3}, {"a": 4}]});
    assert_eq!(encode::encode_with(&small, options)["c1"], json!(1));
}

#[test]
fn a_template_column_is_never_larger_than_its_ordinary_encoding() {
    let body = templated_page();
    let v2 = encode::encode_with(&body, encode::EncodeOptions { templates: true });
    let v1 = encode::encode(&body);
    let size = |doc: &Value, i: usize| serde_json::to_vec(&doc["t"][0]["c"][i]).unwrap().len();
    for i in 0..v1["t"][0]["c"].as_array().unwrap().len() {
        if v2["t"][0]["c"][i]["c"] == json!(5) {
            assert!(size(&v2, i) < size(&v1, i));
        }
    }
}
