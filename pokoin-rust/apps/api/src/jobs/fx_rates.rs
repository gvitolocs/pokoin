//! `job fx-rates-daily [--dry-run]`
//!
//! Downloads the ECB euro reference rates (eurofxref-hist-90d.xml, ~90 days,
//! 1 EUR = `rate` units of `quote`) and upserts them into
//! `public.fx_rates_daily` (scripts/sql/139) per (day, base, quote), so
//! TCGplayer's USD prices convert the same way on the server and on the web
//! (docs/PRICING.md "Price sources"). It writes by default (the timer passes
//! no flags); `--dry-run` downloads, counts and upserts inside a transaction
//! that is rolled back.
use super::Options;
use anyhow::{bail, Context, Result};
use serde_json::json;
use std::collections::BTreeSet;
use std::time::Duration;

const ECB_URL: &str = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";

const UPSERT_SQL: &str = r#"
insert into public.fx_rates_daily (day, base, quote, rate, source)
select d::date, 'EUR', q, r, 'ecb'
from unnest($1::text[], $2::text[], $3::float8[]) as t(d, q, r)
on conflict (day, base, quote)
do update set rate = excluded.rate, loaded_at = now()
  where public.fx_rates_daily.rate is distinct from excluded.rate
"#;

/// One euro reference rate: `1 EUR = rate` units of `quote` on `day`.
pub(super) struct Rate {
    pub day: String,
    pub quote: String,
    pub rate: f64,
}

/// One parsed row of the ECB eurofxref file.
pub(super) fn parse_ecb(xml: &str) -> Vec<Rate> {
    let mut rates = Vec::new();
    let mut day: Option<String> = None;
    let mut from = 0usize;
    while let Some(rel) = xml[from..].find("<Cube") {
        let start = from + rel;
        let Some(close) = xml[start..].find('>') else {
            break;
        };
        let tag = &xml[start..start + close + 1];
        from = start + close + 1;
        // `<Cube` must be the whole tag name, not a prefix of a longer one.
        let after = &tag[5..];
        if !after.is_empty() && !after.starts_with(|c: char| c.is_whitespace() || c == '>') {
            continue;
        }
        match attribute(tag, "time") {
            Some(time) if valid_day(time) => day = Some(time.to_string()),
            _ => {}
        }
        let (Some(quote), Some(rate_text), Some(day)) = (
            attribute(tag, "currency"),
            attribute(tag, "rate"),
            day.clone(),
        ) else {
            continue;
        };
        let Ok(rate) = rate_text.parse::<f64>() else {
            continue;
        };
        if !valid_quote(quote) || !rate.is_finite() || rate <= 0.0 {
            continue;
        }
        rates.push(Rate {
            day,
            quote: quote.to_string(),
            rate,
        });
    }
    rates
}

/// One quoted attribute of an element: `key='value'` or `key="value"`.
fn attribute<'a>(tag: &'a str, key: &str) -> Option<&'a str> {
    let token = tag
        .split(char::is_whitespace)
        .find(|token| token.starts_with(key) && token.get(key.len()..key.len() + 1) == Some("="))?;
    let rest = &token[key.len() + 1..];
    let first = *rest.as_bytes().first()?;
    if first != b'\'' && first != b'"' {
        return None;
    }
    let inner = &rest[1..];
    let end = inner.find(first as char)?;
    Some(&inner[..end])
}

/// `YYYY-MM-DD`: 10 chars, dashes in the 4th and 7th places, digits elsewhere.
fn valid_day(day: &str) -> bool {
    let bytes = day.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..].iter().all(u8::is_ascii_digit)
}

fn valid_quote(quote: &str) -> bool {
    quote.len() == 3 && quote.bytes().all(|byte| byte.is_ascii_uppercase())
}

async fn download() -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let response = client
        .get(ECB_URL)
        .header("User-Agent", "pokoin-fx/1.0")
        .send()
        .await
        .context("ECB euro reference rates download failed")?;
    if !response.status().is_success() {
        bail!(
            "ECB euro reference rates failed: HTTP {}",
            response.status()
        );
    }
    response
        .text()
        .await
        .context("ECB euro reference rates body failed")
}

pub(super) async fn run(options: &Options) -> Result<()> {
    let xml = download().await?;
    let rates = parse_ecb(&xml);
    if rates.is_empty() {
        bail!("no ECB euro reference rates parsed");
    }
    if !rates.iter().any(|rate| rate.quote == "USD") {
        bail!("the ECB euro reference rates have no USD row");
    }
    let latest_day = rates
        .iter()
        .map(|rate| rate.day.as_str())
        .max()
        .unwrap_or_default()
        .to_string();
    let usd = rates
        .iter()
        .find(|rate| rate.day == latest_day && rate.quote == "USD")
        .map(|rate| rate.rate)
        .unwrap_or(0.0);
    let days = rates
        .iter()
        .map(|rate| rate.day.as_str())
        .collect::<BTreeSet<_>>()
        .len();

    let read = super::read_pool().await?;
    let writer = super::writer_pool(&read).await?;
    let mut tx = writer.begin().await?;
    let result = sqlx::query(UPSERT_SQL)
        .bind(
            rates
                .iter()
                .map(|rate| rate.day.clone())
                .collect::<Vec<_>>(),
        )
        .bind(
            rates
                .iter()
                .map(|rate| rate.quote.clone())
                .collect::<Vec<_>>(),
        )
        .bind(rates.iter().map(|rate| rate.rate).collect::<Vec<_>>())
        .execute(&mut *tx)
        .await?;
    let written = result.rows_affected();
    if options.dry_run {
        tx.rollback().await?;
    } else {
        tx.commit().await?;
    }
    println!(
        "{}",
        json!({
            "days": days,
            "rows": rates.len(),
            "written": written,
            "latestDay": latest_day,
            "usd": usd,
            "apply": !options.dry_run,
        })
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "<Cube>
    <Cube time='2026-11-06'>
      <Cube currency='USD' rate='1.0812'/>
      <Cube currency='JPY' rate='164.21'/>
    </Cube>
    <Cube time='2026-11-05'>
      <Cube currency='USD' rate='1.0799'/>
    </Cube>
  </Cube>";

    #[test]
    fn parses_single_quoted_days_and_rates() {
        let rates = parse_ecb(SAMPLE);
        assert_eq!(rates.len(), 3);
        let days: BTreeSet<&str> = rates.iter().map(|rate| rate.day.as_str()).collect();
        assert_eq!(days, ["2026-11-05", "2026-11-06"].into_iter().collect());
        let usd = |day: &str| {
            rates
                .iter()
                .find(|rate| rate.day == day && rate.quote == "USD")
                .expect("USD rate")
                .rate
        };
        assert!((usd("2026-11-06") - 1.0812).abs() < f64::EPSILON);
        assert!((usd("2026-11-05") - 1.0799).abs() < f64::EPSILON);
    }

    #[test]
    fn parses_double_quoted_attributes() {
        let xml = "<Cube><Cube time=\"2026-11-06\"><Cube currency=\"USD\" rate=\"1.0812\"/></Cube></Cube>";
        let rates = parse_ecb(xml);
        assert_eq!(rates.len(), 1);
        assert_eq!(rates[0].day, "2026-11-06");
        assert_eq!(rates[0].quote, "USD");
        assert!((rates[0].rate - 1.0812).abs() < f64::EPSILON);
    }

    #[test]
    fn skips_malformed_entries() {
        let xml = concat!(
            "<Cube currency='USD' rate='1.0'/>", // before any time
            "<Cube time='2026-1-6'><Cube currency='USD' rate='1.1'/></Cube>",
            "<Cube time='2026-11-06'>",
            "<Cube currency='usd' rate='1.2'/>",
            "<Cube currency='USDX' rate='1.3'/>",
            "<Cube currency='USD' rate='abc'/>",
            "<Cube currency='USD' rate='0'/>",
            "<Cube currency='USD' rate='-1'/>",
            "</Cube>",
        );
        assert!(parse_ecb(xml).is_empty());
    }

    #[test]
    fn keeps_valid_entries_among_malformed_ones() {
        let xml = "<Cube time='2026-11-06'><Cube currency='USD' rate='abc'/><Cube currency='USD' rate='1.0812'/><Cube currency='USDX' rate='1.5'/></Cube>";
        let rates = parse_ecb(xml);
        assert_eq!(rates.len(), 1);
        assert_eq!(rates[0].day, "2026-11-06");
        assert_eq!(rates[0].quote, "USD");
    }
}
