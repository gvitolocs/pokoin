//! OpenAI tool schemas for the fifteen market tools, and the in-process runner.
//!
//! Parameter names match what each Rust tool reads (`param_string`, `param_number`,
//! `bounded`, and the sold-facet flags). Descriptions stay to one or two sentences.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Map, Value as Json};
use tokio::task::JoinSet;

use crate::domain::poko_market_math::today_iso;
use crate::handlers::poko_market::{run_tool, tcg_pool, tool_list, MarketDeps};
use crate::state::DomainState;

use super::BrainDeps;

const TOOL_RESULT_CHARS: usize = 6_000;
const ROUND_RESULT_CHARS: usize = 16_000;
const TOOL_TIMEOUT: Duration = Duration::from_secs(8);

/// One tool call the model asked for, after its arguments parsed as JSON.
#[derive(Debug, Clone)]
pub(crate) struct ModelToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Json,
}

#[derive(Debug, Clone)]
pub(crate) struct ExecutedTool {
    pub id: String,
    pub name: String,
    pub arguments: Json,
    pub body: Json,
    pub text: String,
    pub ms: u64,
    pub ok: bool,
}

#[async_trait]
pub trait ToolRunner: Send + Sync {
    async fn run(&self, tool: &str, params: &Json, game: &str) -> Json;
}

/// Production runner: the same `MarketDeps` and `run_tool` as `POST /api/poko-market`.
pub struct MarketToolRunner {
    state: DomainState,
}

impl MarketToolRunner {
    pub fn new(state: DomainState) -> Self {
        Self { state }
    }
}

#[async_trait]
impl ToolRunner for MarketToolRunner {
    async fn run(&self, tool: &str, params: &Json, game: &str) -> Json {
        if !tool_list().contains(&tool) {
            return json!({ "ok": false, "error": "unknown tool" });
        }
        let db = match self.state.marketplace_db() {
            Ok(db) => db,
            Err(error) => {
                tracing::warn!(
                    message = %error.message().chars().take(160).collect::<String>(),
                    "poko-brain market db unavailable"
                );
                return json!({ "ok": false, "tool": tool, "error": "market query failed" });
            }
        };
        let now_ms = self.state.clock().now().timestamp_millis();
        let game = {
            let trimmed = game.trim();
            if trimmed.is_empty() {
                "pokemon".to_string()
            } else {
                trimmed.to_string()
            }
        };
        let deps = MarketDeps {
            db,
            tcg: tcg_pool(),
            game,
            now_ms,
        };
        match run_tool(&deps, tool, params).await {
            Ok(result) => wrap_tool_ok(tool, now_ms, result),
            Err(error) => {
                tracing::warn!(
                    tool = %tool,
                    params = %params.to_string().chars().take(200).collect::<String>(),
                    message = %error.message().chars().take(200).collect::<String>(),
                    "poko-brain tool failed"
                );
                json!({ "ok": false, "tool": tool, "error": "market query failed" })
            }
        }
    }
}

fn wrap_tool_ok(tool: &str, now_ms: i64, result: Json) -> Json {
    let mut payload = Map::new();
    if let Some(fields) = result.as_object() {
        for (key, value) in fields {
            payload.insert(key.clone(), value.clone());
        }
    }
    payload.insert("ok".into(), json!(true));
    payload.insert("tool".into(), json!(tool));
    payload
        .entry("today".to_string())
        .or_insert_with(|| json!(today_iso(now_ms)));
    Json::Object(payload)
}

pub(crate) async fn run_round(
    deps: &BrainDeps,
    game: &str,
    calls: &[ModelToolCall],
) -> Vec<ExecutedTool> {
    let mut set = JoinSet::new();
    for (index, call) in calls.iter().cloned().enumerate() {
        let runner: Arc<dyn ToolRunner> = Arc::clone(&deps.tools);
        let game = game.to_string();
        set.spawn(async move {
            let started = std::time::Instant::now();
            let outcome =
                tokio::time::timeout(TOOL_TIMEOUT, runner.run(&call.name, &call.arguments, &game))
                    .await;
            let ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            let (body, ok) = match outcome {
                Ok(body) => {
                    let ok = body.get("ok").and_then(Json::as_bool).unwrap_or(true);
                    (body, ok)
                }
                Err(_elapsed) => (json!({ "ok": false, "error": "tool timed out" }), false),
            };
            (index, call, body, ms, ok)
        });
    }
    let mut rows = Vec::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(row) => rows.push(row),
            Err(_) => rows.push((
                usize::MAX,
                ModelToolCall {
                    id: "call_failed".into(),
                    name: "unknown".into(),
                    arguments: json!({}),
                },
                json!({ "ok": false, "error": "tool failed" }),
                0,
                false,
            )),
        }
    }
    rows.sort_by_key(|(index, _, _, _, _)| *index);
    let texts = cap_round(rows.iter().map(|(_, _, body, _, _)| body).collect());
    rows.into_iter()
        .zip(texts)
        .map(|((index, call, body, ms, ok), text)| {
            let _ = index;
            ExecutedTool {
                id: call.id,
                name: call.name,
                arguments: call.arguments,
                body,
                text,
                ms,
                ok,
            }
        })
        .collect()
}

fn cap_round(bodies: Vec<&Json>) -> Vec<String> {
    let mut used = 0usize;
    let mut out = Vec::new();
    let mut omitted = false;
    for body in bodies {
        if omitted {
            out.push(r#"{"ok":false,"error":"omitted: round size cap"}"#.to_string());
            continue;
        }
        let text = bound_chars(
            &serde_json::to_string(body).unwrap_or_else(|_| r#"{"ok":false}"#.to_string()),
            TOOL_RESULT_CHARS,
        );
        let len = text.chars().count();
        if used + len > ROUND_RESULT_CHARS {
            omitted = true;
            out.push(r#"{"ok":false,"error":"omitted: round size cap"}"#.to_string());
            continue;
        }
        used += len;
        out.push(text);
    }
    out
}

fn bound_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

pub(crate) fn openai_tools() -> Json {
    Json::Array(tool_schemas())
}

pub(crate) fn tool_schemas() -> Vec<Json> {
    let card = [
        ("cardId", "string", "Pokoin card id when the desk, a photo, or an earlier tool already has one."),
        ("query", "string", "Card name plus set or collector number when cardId is unknown. Do not put time words here."),
        ("artist", "string", "Illustrator name when the user names one."),
    ];
    let variant = [
        ("condition", "string", "NM, SP, MP, PL, or Poor when the user states one. Omit to include every copy of the variant."),
        ("language", "string", "Print language such as EN, IT, or JP when the user states one."),
        ("firstEdition", "string", "\"true\" for a 1st Edition copy, \"false\" for unlimited."),
        ("reverse", "string", "\"true\" for reverse holo, \"false\" for the standard finish."),
        ("graded", "string", "\"true\" for a graded slab, \"false\" for a raw copy."),
    ];
    vec![
        tool(
            "resolve_card",
            "Find catalog printings by name, set, collector number, or artist. One match is ok; several matches are ambiguous and should be asked about.",
            &card,
        ),
        tool(
            "card_quote",
            "Quote one printing: inferred sold median for that variant, the live asking price, and dated price sources. Pass cardId when it is known.",
            &join(&card, &variant, &[("priceDays", "number", "How many recent days of price history to include. Defaults to 14.")]),
        ),
        tool(
            "card_ocr",
            "Read scanned attacks, abilities, and HP for one printing. If status is not_found, scanned text is missing; do not invent it.",
            &card,
        ),
        tool(
            "card_liquidity",
            "Estimate how quickly one printing sells, from recent demand and days of supply.",
            &card,
        ),
        tool(
            "collection_quote",
            "Estimate the value of one illustrator's cards at a condition and language. The artist name is required.",
            &[
                ("artist", "string", "Illustrator name to value."),
                ("condition", "string", "Condition for the estimate. Defaults to NM."),
                ("language", "string", "Language for the estimate. Defaults to EN."),
            ],
        ),
        tool(
            "suggest_cards",
            "Suggest similar real catalog cards for a Pokémon, theme, or other subject. excludeCardId skips the card already on screen.",
            &[
                ("subject", "string", "What to suggest, such as a Pokémon name or a theme. Do not put time words here."),
                ("excludeCardId", "string", "Card id to leave out, usually the one already open."),
                ("limit", "number", "How many cards to return, from 1 to 12. Defaults to 6."),
            ],
        ),
        tool(
            "market_snapshot",
            "Show the busiest cards by units sold over the last 7 days.",
            &[("limit", "number", "How many cards to return, from 1 to 50. Defaults to 10.")],
        ),
        tool(
            "top_movers",
            "Rank cards whose asking price moved up or down over a window. These are asks, not confirmed sales.",
            &[
                ("subject", "string", "Optional name or set to limit the ranking. Do not put time words here."),
                ("query", "string", "Same as subject, used when subject is empty."),
                ("days", "number", "Window length in days, from 7 to 90. Defaults to 30."),
                ("limit", "number", "How many movers to return, from 1 to 10. Defaults to 5."),
                ("direction", "string", "\"up\" for gainers or \"down\" for losers. Defaults to up."),
            ],
        ),
        tool(
            "top_sellers",
            "Rank the most-sold ungraded cards, with optional language, rarity, and price filters.",
            &[
                ("subject", "string", "Optional name or set to limit the ranking."),
                ("query", "string", "Same as subject, used when subject is empty."),
                ("days", "number", "Window length in days, from 1 to 30. Defaults to 7."),
                ("limit", "number", "How many cards to return, from 1 to 20. Defaults to 10."),
                ("language", "string", "Limit to one print language, such as EN or JP."),
                ("rarity", "string", "Rarity label or short form such as SIR, IR, or UR."),
                ("minPriceEur", "number", "Minimum price in EUR. Converted to PKN inside the tool."),
                ("maxPriceEur", "number", "Maximum price in EUR. Converted to PKN inside the tool."),
                ("minPricePkn", "number", "Minimum price in PKN. Wins over minPriceEur when set."),
                ("maxPricePkn", "number", "Maximum price in PKN. Wins over maxPriceEur when set."),
            ],
        ),
        tool(
            "card_sales",
            "List one printing's inferred sales by day, condition, and language, plus 7, 30, and 90 day totals.",
            &join(&card, &variant, &[
                ("days", "number", "How many recent days to list, from 1 to 90. Defaults to 30."),
                ("limit", "number", "How many day rows to return, from 1 to 60. Defaults to 25."),
            ]),
        ),
        tool(
            "deal_check",
            "Compare the cheapest live asks with the sold median of the same slice. Give the verdict and the numbers, not buy-or-sell advice.",
            &join(&card, &variant, &[]),
        ),
        tool(
            "set_sales",
            "Summarize how a whole expansion sells: units, sold value, and its top cards. Ask which set when several match.",
            &[
                ("setName", "string", "Expansion name or code. Preferred over set, query, and subject."),
                ("set", "string", "Expansion name when setName is empty."),
                ("query", "string", "Expansion name when setName and set are empty."),
                ("subject", "string", "Expansion name when the other name fields are empty."),
                ("days", "number", "Window length in days, from 1 to 90. Defaults to 30."),
                ("limit", "number", "How many top cards to return, from 1 to 20. Defaults to 10."),
                ("language", "string", "Limit to one print language."),
            ],
        ),
        tool(
            "recent_sales",
            "List the latest or biggest market-wide sales. Caveat any row marked unverified.",
            &[
                ("subject", "string", "Optional name or set filter."),
                ("query", "string", "Same as subject, used when subject is empty."),
                ("days", "number", "Window length in days, from 1 to 30. Defaults to 3."),
                ("limit", "number", "How many rows to return, from 1 to 25. Defaults to 10."),
                ("sort", "string", "\"price\" for the biggest sales, or \"recent\" for the latest."),
                ("language", "string", "Limit to one print language."),
                ("minPriceEur", "number", "Minimum price in EUR."),
                ("minPricePkn", "number", "Minimum price in PKN. Wins over minPriceEur when set."),
                ("graded", "string", "\"true\" to keep graded slabs only."),
            ],
        ),
        tool(
            "artist_cards",
            "List an illustrator's cards, or say who drew the open card when cardId is passed. Never ask the user for an artist the catalog already has.",
            &[
                ("artist", "string", "Illustrator name. Omit when cardId should supply it."),
                ("cardId", "string", "Open card id, used to answer who drew this card."),
                ("sort", "string", "\"expensive\", \"cheapest\", or \"sold\"."),
                ("limit", "number", "How many cards to return, from 1 to 20. Defaults to 10."),
                ("language", "string", "Limit to one print language."),
            ],
        ),
        tool(
            "set_info",
            "Catalog facts for an expansion: era, nationality, release languages, localized name, and card count. Do not invent a year the result lacks.",
            &[
                ("setName", "string", "Expansion name or code. Preferred over set, query, and subject."),
                ("set", "string", "Expansion name when setName is empty."),
                ("query", "string", "Expansion name when setName and set are empty."),
                ("subject", "string", "Expansion name when the other name fields are empty."),
                ("era", "string", "Era block such as Sword & Shield or Scarlet & Violet."),
                ("language", "string", "Language used to prefer a nationality or a localized name."),
                ("nationality", "string", "japanese, western, chinese, or korean."),
                ("limit", "number", "How many sets to return, from 1 to 40."),
            ],
        ),
    ]
}

fn join<'a>(
    left: &'a [(&str, &str, &str)],
    mid: &'a [(&str, &str, &str)],
    right: &'a [(&str, &str, &str)],
) -> Vec<(&'a str, &'a str, &'a str)> {
    left.iter()
        .chain(mid.iter())
        .chain(right.iter())
        .copied()
        .collect()
}

fn tool(name: &str, description: &str, fields: &[(&str, &str, &str)]) -> Json {
    let mut properties = Map::new();
    for (field, kind, detail) in fields {
        properties.insert(
            (*field).to_string(),
            json!({ "type": kind, "description": detail }),
        );
    }
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": Json::Object(properties),
                "additionalProperties": false,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schemas_list_exactly_the_market_tools() {
        let schemas = tool_schemas();
        let names: Vec<&str> = schemas
            .iter()
            .map(|schema| schema["function"]["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, tool_list().to_vec());
        let quote = tool_schemas()
            .into_iter()
            .find(|schema| schema["function"]["name"] == "card_quote")
            .unwrap();
        let properties = quote["function"]["parameters"]["properties"]
            .as_object()
            .unwrap();
        for key in [
            "cardId",
            "query",
            "condition",
            "language",
            "firstEdition",
            "reverse",
            "graded",
            "priceDays",
        ] {
            assert!(properties.contains_key(key), "card_quote missing {key}");
        }
    }

    #[test]
    fn round_cap_keeps_each_result_and_the_round_bounded() {
        let huge = json!("x".repeat(8_000));
        let texts = cap_round(vec![&huge, &huge, &huge]);
        assert!(texts[0].chars().count() <= TOOL_RESULT_CHARS);
        assert!(
            texts.iter().map(|text| text.chars().count()).sum::<usize>()
                <= ROUND_RESULT_CHARS + TOOL_RESULT_CHARS
        );
    }
}
