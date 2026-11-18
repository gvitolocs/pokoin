//! `pokoin-tcgplayer-match` — link unlinked Pokémon printings to TCGplayer
//! products. Dry-run by default; `--apply` writes `pokoin_product_links` rows
//! with `match_source = 'pokoin-matcher'`. See docs/TCGPLAYER_MATCH.md.
//!
//!   MARKET_DATABASE_URL=… TCGPRICES_DATABASE_URL=… pokoin-tcgplayer-match [--apply] [--out DIR]

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;
use std::path::PathBuf;
use std::time::Instant;

use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::Row;
use tcgplayer_match::{card_number, Card, Matcher, Outcome, Product, POKEMON, POKEMON_JAPAN};

const SOURCE: &str = "pokoin-matcher";
/// Shared with tcgprices/sync_pokoin_links.py so the two writers never interleave.
const LINKS_LOCK: i64 = 817_482_942;

const CARDS_SQL: &str = "
SELECT c.card_id, c.ct_id, coalesce(b.name, c.name) AS name, c.name AS alt_name,
       coalesce(b.blueprint->'fixed_properties'->>'collector_number','') AS collector,
       coalesce(b.version,'') AS version, c.card_number,
       coalesce(b.expansion_id,0)::bigint AS expansion_id,
       coalesce(b.expansion->>'name','') AS expansion_name,
       coalesce(b.expansion->>'code','') AS expansion_code,
       coalesce(e.nationality,'') AS nationality
FROM public.marketplace_cards c
JOIN public.cardtrader_pokemon_blueprints b ON b.id = c.ct_id
LEFT JOIN public.cardtrader_pokemon_expansions e ON e.expansion_id = b.expansion_id
WHERE c.product_type = 'card'";

const PRODUCTS_SQL: &str = "
SELECT DISTINCT ON (product_id) product_id, group_id::bigint AS group_id, category_id,
       coalesce(name,'') AS name, coalesce(raw_data->>'extNumber','') AS number,
       coalesce(set_name,'') AS group_name
FROM latest_prices
WHERE category_id = ANY($1) AND product_id IS NOT NULL
ORDER BY product_id";

const LINKS_SQL: &str = "
SELECT card_id, product_id FROM pokoin_product_links l
WHERE game = 'pokemon' AND active
  AND coalesce(to_jsonb(l)->>'match_source', 'cardtrader') <> 'pokoin-matcher'";

const APPLY_SQL: &str = "
INSERT INTO pokoin_product_links (game, card_id, ct_id, product_id, metadata, match_source)
SELECT 'pokemon', card_id, ct_id, product_id, metadata::jsonb, 'pokoin-matcher'
FROM UNNEST($1::bigint[], $2::bigint[], $3::bigint[], $4::text[]) AS m(card_id, ct_id, product_id, metadata)
ON CONFLICT (game, card_id, product_id) DO UPDATE
SET ct_id = EXCLUDED.ct_id, metadata = EXCLUDED.metadata, last_seen = now(), active = true,
    match_source = 'pokoin-matcher'
WHERE pokoin_product_links.match_source = 'pokoin-matcher' OR NOT pokoin_product_links.active";

struct Args {
    apply: bool,
    out: PathBuf,
    /// Hide every Nth explicitly linked card and report agreement on those.
    holdout: Option<i64>,
    /// Hide whole expansions instead of single cards (no sibling links vote).
    holdout_sets: bool,
}

fn args() -> Result<Args, String> {
    let mut parsed = Args {
        apply: false,
        out: PathBuf::from("."),
        holdout: None,
        holdout_sets: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--apply" => parsed.apply = true,
            "--out" => parsed.out = it.next().ok_or("--out needs a directory")?.into(),
            "--holdout-sets" => parsed.holdout_sets = true,
            "--holdout" => {
                let n: i64 = it.next().and_then(|v| v.parse().ok()).filter(|n| *n > 1).ok_or("--holdout needs N > 1")?;
                parsed.holdout = Some(n);
            }
            "-h" | "--help" => {
                return Err("usage: pokoin-tcgplayer-match [--apply | --holdout N [--holdout-sets]] [--out DIR]\n  env MARKET_DATABASE_URL, TCGPRICES_DATABASE_URL".into())
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(parsed)
}

fn env_url(key: &str) -> Result<String, String> {
    std::env::var(key)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| format!("{key} is not set"))
}

fn tsv(text: &str) -> String {
    text.replace(['\t', '\n', '\r'], " ")
}

async fn run() -> Result<(), String> {
    let args = args()?;
    let started = Instant::now();
    let market = PgPoolOptions::new()
        .max_connections(1)
        .connect(&env_url("MARKET_DATABASE_URL")?)
        .await
        .map_err(|e| format!("market db: {e}"))?;
    let prices = PgPoolOptions::new()
        .max_connections(2)
        .connect(&env_url("TCGPRICES_DATABASE_URL")?)
        .await
        .map_err(|e| format!("tcgprices db: {e}"))?;

    let has_source: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pokoin_product_links' AND column_name = 'match_source')",
    )
    .fetch_one(&prices)
    .await
    .map_err(|e| e.to_string())?;
    if args.apply && !has_source {
        return Err("pokoin_product_links.match_source is missing: apply docs/TCGPLAYER_MATCH.md migration first".into());
    }

    let (cards, products, links) = tokio::try_join!(
        async {
            sqlx::query(CARDS_SQL).fetch_all(&market).await.map(|rows| {
                rows.iter()
                    .map(|r| Card {
                        card_id: r.get("card_id"),
                        ct_id: r.get("ct_id"),
                        name: r.get("name"),
                        alt_name: r.get("alt_name"),
                        numbers: vec![r.get("collector"), r.get("version"), r.get("card_number")],
                        expansion_id: r.get("expansion_id"),
                        expansion_name: r.get("expansion_name"),
                        expansion_code: r.get("expansion_code"),
                        nationality: r.get("nationality"),
                    })
                    .collect::<Vec<_>>()
            })
        },
        async {
            sqlx::query(PRODUCTS_SQL)
                .bind(vec![POKEMON, POKEMON_JAPAN])
                .fetch_all(&prices)
                .await
                .map(|rows| {
                    rows.iter()
                        .map(|r| Product {
                            product_id: r.get("product_id"),
                            group_id: r.get("group_id"),
                            category_id: r.get("category_id"),
                            name: r.get("name"),
                            number: r.get("number"),
                            group_name: r.get("group_name"),
                        })
                        .collect::<Vec<_>>()
                })
        },
        async {
            sqlx::query(LINKS_SQL).fetch_all(&prices).await.map(|rows| {
                let mut links: HashMap<i64, Vec<i64>> = HashMap::new();
                for r in rows {
                    links
                        .entry(r.get("card_id"))
                        .or_default()
                        .push(r.get("product_id"));
                }
                links
            })
        },
    )
    .map_err(|e| format!("load: {e}"))?;
    let loaded = started.elapsed();
    if args.holdout.is_some() && args.apply {
        return Err("--holdout is a dry-run measurement; drop --apply".into());
    }
    if let Some(n) = args.holdout {
        return holdout(n, args.holdout_sets, &cards, &products, links, &args.out);
    }

    let result = Matcher {
        cards: &cards,
        products: &products,
        links: &links,
    }
    .run();
    let matched_in = started.elapsed() - loaded;

    let group_title: HashMap<i64, &str> = products
        .iter()
        .map(|p| (p.group_id, p.group_name.as_str()))
        .collect();
    let mut counts: BTreeMap<String, BTreeMap<&str, usize>> = BTreeMap::new();
    let mut by_method: BTreeMap<String, usize> = BTreeMap::new();
    let mut matches = String::from("card_id\tct_id\tproduct_id\tgroup_id\tmethod\tname\tnumber\texpansion\ttcg_name\ttcg_number\ttcg_group\n");
    let mut unresolved =
        String::from("card_id\tct_id\tstatus\tdetail\tname\tnumber\texpansion\tnationality\n");
    let (mut ids, mut ct_ids, mut product_ids, mut metadata) = (vec![], vec![], vec![], vec![]);
    for (card, outcome) in cards.iter().zip(&result.outcomes) {
        let nationality = if card.nationality.is_empty() {
            "unknown"
        } else {
            card.nationality.as_str()
        };
        *counts
            .entry(nationality.to_string())
            .or_default()
            .entry(outcome.status())
            .or_default() += 1;
        let number = card
            .numbers
            .iter()
            .find(|n| !n.is_empty())
            .cloned()
            .unwrap_or_default();
        match outcome {
            Outcome::Matched {
                product,
                tier,
                score,
            } => {
                let p = &products[*product];
                let key = if card_number(card).is_some() {
                    "number"
                } else {
                    "unnumbered"
                };
                let name = match score {
                    3 => "name",
                    2 => "base-name",
                    _ => "variant-name",
                };
                let method = format!("{}+{key}+{name}", tier.label());
                *by_method.entry(method.clone()).or_default() += 1;
                let _ = writeln!(
                    matches,
                    "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                    card.card_id,
                    card.ct_id,
                    p.product_id,
                    p.group_id,
                    method,
                    tsv(&card.name),
                    tsv(&number),
                    tsv(&card.expansion_name),
                    tsv(&p.name),
                    tsv(&p.number),
                    tsv(&p.group_name)
                );
                ids.push(card.card_id);
                ct_ids.push(card.ct_id);
                product_ids.push(p.product_id);
                metadata.push(
                    json!({
                        "source": SOURCE,
                        "method": method,
                        "card_id": card.card_id,
                        "ct_id": card.ct_id,
                        "name": card.name,
                        "number": number,
                        "normalized_number": card_number(card),
                        "expansion_id": card.expansion_id,
                        "expansion": card.expansion_name,
                        "tcg_name": p.name,
                        "tcg_number": p.number,
                        "group_id": p.group_id,
                        "group": p.group_name,
                        "category_id": p.category_id,
                    })
                    .to_string(),
                );
            }
            Outcome::AlreadyLinked | Outcome::Unsupported => {}
            other => {
                let detail = match other {
                    Outcome::Ambiguous(ids) => {
                        ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
                    }
                    Outcome::ProductTaken(owner) => format!("owner {owner}"),
                    Outcome::Shared(product) => format!("product {product}"),
                    Outcome::NoGroup | Outcome::NoCandidate | Outcome::NameMismatch => result
                        .groups
                        .get(&card.expansion_id)
                        .map(|g| {
                            g.iter()
                                .map(|(t, id)| {
                                    format!("{}:{}", t.label(), group_title.get(id).unwrap_or(&""))
                                })
                                .collect::<Vec<_>>()
                                .join("; ")
                        })
                        .unwrap_or_default(),
                    _ => String::new(),
                };
                let _ = writeln!(
                    unresolved,
                    "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                    card.card_id,
                    card.ct_id,
                    other.status(),
                    tsv(&detail),
                    tsv(&card.name),
                    tsv(&number),
                    tsv(&card.expansion_name),
                    nationality
                );
            }
        }
    }

    std::fs::create_dir_all(&args.out).map_err(|e| e.to_string())?;
    std::fs::write(args.out.join("tcgplayer-matches.tsv"), matches).map_err(|e| e.to_string())?;
    std::fs::write(args.out.join("tcgplayer-unresolved.tsv"), unresolved)
        .map_err(|e| e.to_string())?;

    let mut written = 0u64;
    let mut retired = 0u64;
    if args.apply {
        let mut tx = prices.begin().await.map_err(|e| e.to_string())?;
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(LINKS_LOCK)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        retired = sqlx::query("UPDATE pokoin_product_links SET active = false WHERE game = 'pokemon' AND match_source = 'pokoin-matcher' AND active")
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?
            .rows_affected();
        written = sqlx::query(APPLY_SQL)
            .bind(&ids)
            .bind(&ct_ids)
            .bind(&product_ids)
            .bind(&metadata)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?
            .rows_affected();
        tx.commit().await.map_err(|e| e.to_string())?;
    }

    let report: Value = json!({
        "source": SOURCE,
        "apply": args.apply,
        "cards": cards.len(),
        "tcgplayer_products": products.len(),
        "explicit_linked_cards": links.len(),
        "matched": ids.len(),
        "by_method": by_method,
        "by_nationality": counts,
        "written": written,
        "previous_matcher_rows_retired": retired,
        "load_ms": loaded.as_millis(),
        "match_ms": matched_in.as_millis(),
        "total_ms": started.elapsed().as_millis(),
    });
    let text = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    std::fs::write(
        args.out.join("tcgplayer-match-report.json"),
        format!("{text}\n"),
    )
    .map_err(|e| e.to_string())?;
    println!("{text}");
    Ok(())
}

/// Precision check: hide every Nth explicit link, re-match those cards blind
/// and compare with CardTrader's own TCGplayer ids.
fn holdout(
    n: i64,
    by_set: bool,
    cards: &[Card],
    products: &[Product],
    mut links: HashMap<i64, Vec<i64>>,
    out: &PathBuf,
) -> Result<(), String> {
    let expansion: HashMap<i64, i64> = cards.iter().map(|c| (c.card_id, c.expansion_id)).collect();
    let hide = |id: i64| {
        if by_set {
            expansion.get(&id).is_some_and(|e| e % n == 0)
        } else {
            (id / 2) % n == 0
        }
    };
    let hidden: HashMap<i64, Vec<i64>> = links
        .iter()
        .filter(|(id, _)| hide(**id))
        .map(|(k, v)| (*k, v.clone()))
        .collect();
    links.retain(|id, _| !hidden.contains_key(id));
    let result = Matcher {
        cards,
        products,
        links: &links,
    }
    .run();
    let (mut agree, mut disagree, mut unmatched) = (0usize, 0usize, BTreeMap::<&str, usize>::new());
    let mut rows = String::from(
        "card_id\tname\tnumber\texpansion\tmatched_product\tmatched_name\tcardtrader_products\n",
    );
    for (card, outcome) in cards.iter().zip(&result.outcomes) {
        let Some(truth) = hidden.get(&card.card_id) else {
            continue;
        };
        match outcome {
            Outcome::Matched { product, .. } if truth.contains(&products[*product].product_id) => {
                agree += 1
            }
            Outcome::Matched { product, .. } => {
                disagree += 1;
                let p = &products[*product];
                let _ = writeln!(
                    rows,
                    "{}\t{}\t{}\t{}\t{}\t{}\t{:?}",
                    card.card_id,
                    tsv(&card.name),
                    tsv(card
                        .numbers
                        .iter()
                        .find(|x| !x.is_empty())
                        .map(String::as_str)
                        .unwrap_or("")),
                    tsv(&card.expansion_name),
                    p.product_id,
                    tsv(&p.name),
                    truth
                );
            }
            other => *unmatched.entry(other.status()).or_default() += 1,
        }
    }
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    std::fs::write(out.join("tcgplayer-holdout-disagreements.tsv"), rows)
        .map_err(|e| e.to_string())?;
    let matched = agree + disagree;
    let report = json!({
        "holdout_every": n,
        "holdout_by": if by_set { "expansion" } else { "card" },
        "hidden_cards": hidden.len(),
        "matched": matched,
        "agree": agree,
        "disagree": disagree,
        "precision": if matched > 0 { agree as f64 / matched as f64 } else { 0.0 },
        "recall": if hidden.is_empty() { 0.0 } else { agree as f64 / hidden.len() as f64 },
        "unmatched": unmatched,
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("pokoin-tcgplayer-match: {error}");
        std::process::exit(1);
    }
}
