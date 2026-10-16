//! Dead-man pings (healthchecks.io API, or a self-hosted Healthchecks with the same API).
//! One project ping key per host (POKOIN_HC_PING_KEY); each timer pings its own slug.
//! Without a key every ping is a no-op, so units can carry the ping lines before setup.

use crate::env;
use anyhow::{anyhow, bail, Result};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Success,
    Start,
    Fail,
}

impl Kind {
    pub fn parse(s: &str) -> Result<Kind> {
        Ok(match s {
            "" | "ok" | "success" | "0" => Kind::Success,
            "start" => Kind::Start,
            "fail" => Kind::Fail,
            other => bail!("unknown ping kind {other:?} (ok|start|fail)"),
        })
    }
    fn suffix(self) -> &'static str {
        match self {
            Kind::Success => "",
            Kind::Start => "/start",
            Kind::Fail => "/fail",
        }
    }
}

/// `pokoin-rust-job@search-delta.service` → `pi-job-search-delta` with prefix `pi-`.
pub fn slug_for_unit(prefix: &str, unit: &str) -> String {
    let base = unit.strip_suffix(".service").unwrap_or(unit);
    let base = base.strip_prefix("pokoin-").unwrap_or(base);
    let base = base.replace("rust-job@", "job-");
    let mut slug: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let slug = slug.trim_matches('-').to_string();
    if prefix.is_empty() || slug.starts_with(prefix) {
        slug
    } else {
        format!("{prefix}{slug}")
    }
}

pub fn host_prefix() -> String {
    env::get("POKOIN_HC_SLUG_PREFIX").unwrap_or_default()
}

pub fn ping(slug: &str, kind: Kind, body: &str) -> Result<bool> {
    let Some(key) = env::get("POKOIN_HC_PING_KEY") else {
        return Ok(false);
    };
    let base = env::get_or("POKOIN_HC_PING_BASE", "https://hc-ping.com");
    let url = format!("{}/{}/{}{}?create=1", base.trim_end_matches('/'), key, slug, kind.suffix());
    if env::get("POKOIN_OPS_DRY_RUN").is_some() {
        eprintln!("[dry-run ping] {slug}{}", kind.suffix());
        return Ok(true);
    }
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).build();
    let mut last = String::new();
    for attempt in 0..3u64 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_secs(2 * attempt));
        }
        match agent.post(&url).send_string(&crate::mail::truncate(body, 9_000)) {
            Ok(_) => return Ok(true),
            Err(err) => last = err.to_string().replace(&key, "<key>"),
        }
    }
    Err(anyhow!("healthchecks ping {slug} failed: {last}"))
}

/// Period and grace for every dead-man check; `hc-provision` upserts these.
pub struct CheckSpec {
    pub slug: &'static str,
    pub period_s: u64,
    pub grace_s: u64,
    pub what: &'static str,
}

const MIN: u64 = 60;
const HOUR: u64 = 3600;
const DAY: u64 = 86_400;

pub const CHECKS: &[CheckSpec] = &[
    CheckSpec { slug: "pi-job-search-delta", period_s: 2 * MIN, grace_s: 10 * MIN, what: "Pi search delta, every 2 min" },
    CheckSpec { slug: "pi-job-eur-orders-sweep", period_s: 5 * MIN, grace_s: 15 * MIN, what: "Pi EUR order sweep, every 5 min" },
    CheckSpec { slug: "pi-job-referral-reconcile", period_s: 10 * MIN, grace_s: 20 * MIN, what: "Pi referral reconcile, every 10 min" },
    CheckSpec { slug: "pi-job-cardtrader-seller-reconcile", period_s: 20 * MIN, grace_s: 30 * MIN, what: "Pi seller reconcile, 10 min after the last run" },
    CheckSpec { slug: "pi-watchdog", period_s: 5 * MIN, grace_s: 15 * MIN, what: "Pi watchdog, every 5 min" },
    CheckSpec { slug: "pi-wal-push", period_s: MIN, grace_s: 15 * MIN, what: "Pi WAL spool upload, every minute" },
    CheckSpec { slug: "pi-basebackup", period_s: 7 * DAY, grace_s: 6 * HOUR, what: "Pi wal-g base backup, weekly" },
    CheckSpec { slug: "pi-sentinel", period_s: 5 * MIN, grace_s: 15 * MIN, what: "Pi sentinel, every 5 min" },
    CheckSpec { slug: "nezopt-all-cardtrader-daily", period_s: DAY, grace_s: 13 * HOUR, what: "nezopt CardTrader daily, 23:00 UTC, up to 12 h" },
    CheckSpec { slug: "nezopt-site-map-refresh", period_s: 7 * DAY, grace_s: 2 * HOUR, what: "nezopt site map, weekly" },
    CheckSpec { slug: "nezopt-uptime-mail", period_s: 2 * MIN, grace_s: 10 * MIN, what: "nezopt /healthz mailer, every 2 min" },
    CheckSpec { slug: "nezopt-overflow-sync", period_s: 5 * MIN, grace_s: 20 * MIN, what: "nezopt overflow sync, about every 5 min" },
    CheckSpec { slug: "nezopt-shipping-rates-sync", period_s: DAY, grace_s: 2 * HOUR, what: "nezopt shipping rates, daily" },
    CheckSpec { slug: "nezopt-pgdump", period_s: DAY, grace_s: 6 * HOUR, what: "nezopt nightly pg_dump of the Pi replica" },
    CheckSpec { slug: "nezopt-backup-mirror", period_s: DAY, grace_s: 3 * HOUR, what: "nezopt mirror of the wal-g store to mybook" },
    CheckSpec { slug: "nezopt-restore-test", period_s: 31 * DAY, grace_s: DAY, what: "nezopt monthly restore tests" },
    CheckSpec { slug: "nezopt-sentinel", period_s: 5 * MIN, grace_s: 15 * MIN, what: "nezopt sentinel, every 5 min" },
    CheckSpec { slug: "oracle-cardtrader-daily-market-refresh", period_s: DAY, grace_s: 36 * HOUR, what: "Oracle CardTrader market refresh, 01:00 UTC, up to 36 h" },
];

/// Create or update every check (Healthchecks management API v3, `unique: ["slug"]`).
pub fn provision() -> Result<()> {
    let key = env::get("POKOIN_HC_API_KEY").ok_or_else(|| anyhow!("POKOIN_HC_API_KEY is not set"))?;
    let base = env::get_or("POKOIN_HC_API_BASE", "https://healthchecks.io");
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).build();
    for spec in CHECKS {
        let body = serde_json::json!({
            "name": spec.slug,
            "slug": spec.slug,
            "desc": spec.what,
            "timeout": spec.period_s,
            "grace": spec.grace_s,
            "channels": "*",
            "unique": ["slug"],
        });
        agent
            .post(&format!("{}/api/v3/checks/", base.trim_end_matches('/')))
            .set("X-Api-Key", &key)
            .send_json(body)
            .map_err(|e| anyhow!("{}: {e}", spec.slug))?;
        println!("ok {}", spec.slug);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_follow_units() {
        assert_eq!(slug_for_unit("pi-", "pokoin-rust-job@search-delta.service"), "pi-job-search-delta");
        assert_eq!(slug_for_unit("pi-", "pokoin-pi-watchdog.service"), "pi-watchdog");
        assert_eq!(slug_for_unit("nezopt-", "pokoin-all-cardtrader-daily.service"), "nezopt-all-cardtrader-daily");
        assert_eq!(
            slug_for_unit("oracle-", "pokoin-cardtrader-daily-market-refresh.service"),
            "oracle-cardtrader-daily-market-refresh"
        );
        assert_eq!(slug_for_unit("", "Weird_Unit@x.y.service"), "weird-unit-x-y");
    }

    #[test]
    fn every_timer_slug_has_a_spec() {
        for (prefix, unit) in [
            ("pi-", "pokoin-rust-job@search-delta.service"),
            ("pi-", "pokoin-rust-job@eur-orders-sweep.service"),
            ("pi-", "pokoin-rust-job@referral-reconcile.service"),
            ("pi-", "pokoin-rust-job@cardtrader-seller-reconcile.service"),
            ("pi-", "pokoin-pi-watchdog.service"),
            ("pi-", "pokoin-wal-push.service"),
            ("pi-", "pokoin-basebackup.service"),
            ("pi-", "pokoin-sentinel.service"),
            ("nezopt-", "pokoin-all-cardtrader-daily.service"),
            ("nezopt-", "pokoin-site-map-refresh.service"),
            ("nezopt-", "pokoin-uptime-mail.service"),
            ("nezopt-", "pokoin-overflow-sync.service"),
            ("nezopt-", "pokoin-shipping-rates-sync.service"),
            ("nezopt-", "pokoin-pgdump.service"),
            ("nezopt-", "pokoin-backup-mirror.service"),
            ("nezopt-", "pokoin-restore-test.service"),
            ("nezopt-", "pokoin-sentinel.service"),
            ("oracle-", "pokoin-cardtrader-daily-market-refresh.service"),
        ] {
            let slug = slug_for_unit(prefix, unit);
            assert!(CHECKS.iter().any(|c| c.slug == slug), "no CheckSpec for {slug}");
        }
        for spec in CHECKS {
            assert!(spec.period_s >= 60 && spec.grace_s >= 60, "{}", spec.slug);
        }
    }

    #[test]
    fn kinds_parse() {
        assert_eq!(Kind::parse("start").unwrap(), Kind::Start);
        assert_eq!(Kind::parse("").unwrap(), Kind::Success);
        assert!(Kind::parse("nope").is_err());
    }
}
