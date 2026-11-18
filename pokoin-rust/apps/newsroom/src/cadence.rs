use crate::{array, game, sources, text, timestamp};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;

pub const HOUR: i64 = 3_600_000;
pub const DAY: i64 = 24 * HOUR;
pub const POPULAR: &[&str] = &[
    "pokemon",
    "one_piece",
    "magic",
    "yugioh",
    "lorcana",
    "riftbound",
];
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cadence {
    pub kind: &'static str,
    pub per_period: usize,
    pub period_ms: i64,
    pub min_gap_ms: i64,
    pub max_attempts_per_period: usize,
    pub min_story_age_ms: i64,
    pub max_story_age_ms: i64,
}
pub fn cadence_for(game: &str) -> Cadence {
    if POPULAR.contains(&game) {
        Cadence {
            kind: "daily",
            per_period: 2,
            period_ms: DAY,
            min_gap_ms: 6 * HOUR,
            max_attempts_per_period: 4,
            min_story_age_ms: 0,
            max_story_age_ms: 36 * HOUR,
        }
    } else {
        Cadence {
            kind: "weekly",
            per_period: 1,
            period_ms: 7 * DAY,
            min_gap_ms: 7 * DAY,
            max_attempts_per_period: 2,
            min_story_age_ms: 2 * DAY,
            max_story_age_ms: 7 * DAY,
        }
    }
}
pub fn slot_open(id: &str, records: &[Value], attempts: &[Value], now: i64) -> Value {
    let c = cadence_for(id);
    let start = if c.kind == "daily" {
        now.div_euclid(DAY) * DAY
    } else {
        now - c.period_ms
    };
    let published_records: Vec<_> = records
        .iter()
        .filter(|r| {
            game(r) == id
                && text(r, "status") == "published"
                && !text(r, "datePublished").is_empty()
        })
        .collect();
    // cadence.js:38-39 lets a bad date pass as NaN and quietly counts nothing.
    // Here it closes the slot instead: a record nobody can date is not a slot.
    if let Some(broken) = published_records
        .iter()
        .find(|r| timestamp(text(r, "datePublished")).is_none())
    {
        return json!({"open":false,"reason":format!("unparseable datePublished on {}",text(broken,"id")),"cadence":c});
    }
    let published: Vec<_> = published_records
        .iter()
        .filter_map(|r| timestamp(text(r, "datePublished")))
        .collect();
    let drafted = records
        .iter()
        .filter(|r| {
            game(r) == id
                && text(r, "status") == "review"
                && timestamp(text(&r["revisions"][0], "at")).is_some_and(|t| t >= start)
        })
        .count();
    let count = published.iter().filter(|&&t| t >= start).count() + drafted;
    let reason = if count >= c.per_period {
        Some(format!(
            "{count}/{} published or in review this {}",
            c.per_period,
            if c.kind == "daily" { "day" } else { "week" }
        ))
    } else if published
        .iter()
        .max()
        .is_some_and(|&t| now - t < c.min_gap_ms)
    {
        Some("too soon after the last article".into())
    } else {
        None
    };
    let tried = attempts
        .iter()
        .filter(|a| text(a, "game") == id && timestamp(text(a, "at")).is_some_and(|t| t >= start))
        .count();
    let reason = reason.or_else(|| {
        (tried >= c.max_attempts_per_period)
            .then(|| "generation attempts used up for this period".into())
    });
    if let Some(reason) = reason {
        json!({"open":false,"reason":reason,"cadence":c})
    } else {
        json!({"open":true,"reason":"slot open","attemptsLeft":c.max_attempts_per_period-tried,"cadence":c})
    }
}
pub fn pick_candidates<'a>(
    id: &str,
    stories: &'a [Value],
    records: &[Value],
    now: i64,
) -> Vec<&'a Value> {
    let c = cadence_for(id);
    let covered: HashSet<_> = records.iter().map(|r| &r["canonicalStoryId"]).collect();
    let mut candidates: Vec<_> = stories
        .iter()
        .filter(|s| {
            let seen = ["first_seen_at", "last_updated_at"]
                .iter()
                .map(|k| text(s, k))
                .find(|v| !v.is_empty());
            let age = seen.map_or(Some(0), |v| timestamp(v).map(|t| now - t));
            game(s) == id
                && !covered.contains(&s["id"])
                && age.is_some_and(|age| age >= c.min_story_age_ms && age <= c.max_story_age_ms)
        })
        .collect();
    let outlets = |s: &Value| {
        array(&s["sources"])
            .iter()
            .map(|r| text(r, "source").to_lowercase())
            .collect::<HashSet<_>>()
            .len()
    };
    let tier = |s: &Value| {
        array(&s["sources"])
            .iter()
            .map(|r| {
                let value = ["source_url", "link", "source"]
                    .iter()
                    .map(|k| text(r, k))
                    .find(|v| !v.is_empty())
                    .unwrap_or("");
                sources::source_tier(value)
            })
            .min()
            .unwrap_or('D')
    };
    candidates.sort_by(|a, b| {
        outlets(b)
            .cmp(&outlets(a))
            .then_with(|| tier(a).cmp(&tier(b)))
            .then_with(|| {
                timestamp(text(b, "last_updated_at")).cmp(&timestamp(text(a, "last_updated_at")))
            })
    });
    candidates
}
pub fn plan(stories: &[Value], records: &[Value], state: &Value, now: i64) -> Value {
    let games: Value =
        serde_json::from_str(include_str!("../assets/games.json")).unwrap_or(Value::Null);
    let rows: Vec<_> = array(&games)
        .iter()
        .filter(|g| g["newsActive"] == true)
        .map(|g| {
            let id = text(g, "id");
            let slot = slot_open(id, records, array(&state["attempts"]), now);
            let n = slot["attemptsLeft"].as_u64().unwrap_or(0) as usize;
            let candidates: Vec<_> = pick_candidates(id, stories, records, now)
                .iter()
                .take(n)
                .map(|s| s["id"].clone())
                .collect();
            json!({"game":id,"slot":slot,"candidates":candidates})
        })
        .collect();
    let updates: Vec<_> = records
        .iter()
        .filter(|r| text(r, "status") == "published")
        .filter_map(|r| {
            let story = stories.iter().find(|s| s["id"] == r["canonicalStoryId"])?;
            // newsroom-publisher.mjs:104-106 compares Math.max over Date.parse,
            // so one source that cannot be dated, or a record with no
            // dateModified, fails the whole record closed: no update.
            let mut newest = None;
            for source in array(&story["sources"]) {
                match timestamp(text(source, "added_at")) {
                    Some(at) => newest = Some(newest.map_or(at, |max: i64| max.max(at))),
                    None => return None,
                }
            }
            let modified = timestamp(text(r, "dateModified"))?;
            // Node Date.parse(0) = 2000-01-01, long before any newsroom record.
            let last = timestamp(state["updates"][text(r, "id")].as_str().unwrap_or(""))
                .unwrap_or(946684800000);
            (newest.is_some_and(|newest| newest > modified) && now - last >= 12 * HOUR)
                .then(|| json!({"id":r["id"],"storyId":story["id"],"slug":r["slug"]}))
        })
        .collect();
    json!({"games":rows,"updates":updates})
}
