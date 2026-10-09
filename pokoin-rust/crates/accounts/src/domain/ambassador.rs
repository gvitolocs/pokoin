//! Pokoin Ambassador program — a port of `_ambassador_core.js`.
//!
//! Referrals reward who you bring; Ambassadors are recognised for what they
//! contribute. "Bring 3 collectors" counts itself from rewarded referrals;
//! every other mission is verified by the Pokoin team and stored in
//! `public.marketplace_ambassador_contributions`.
//!
//! Tiers: Collector → Ambassador (3 missions, or named on the roster) →
//! Senior Ambassador (5 missions and 10 activated referrals) → City Ambassador
//! (an ambassador the roster assigns to a city). Roster role
//! `founder_ambassador` is an ambassador with the one-off Founder title.

use serde_json::{json, Value as Json};

pub const MISSION_KEYS: [&str; 6] = [
    "referrals",
    "content",
    "bug_report",
    "seller_onboard",
    "community_event",
    "feedback",
];
pub const REFERRAL_MISSION_TARGET: i64 = 3;
pub const AMBASSADOR_MISSIONS: i64 = 3;
pub const SENIOR_MISSIONS: i64 = 5;
pub const SENIOR_REFERRALS: i64 = 10;
pub const AMBASSADOR_ROLES: [&str; 2] = ["ambassador", "founder_ambassador"];

/// The roster row from `marketplace_associates`, if any.
#[derive(Debug, Clone, Default)]
pub struct Roster {
    pub role: String,
    pub city: String,
    pub active: bool,
    pub present: bool,
}

impl Roster {
    /// `Boolean(roster) && roster.active !== false` — a row with no explicit
    /// `active` flag counts as active.
    pub fn is_active(&self) -> bool {
        self.present && self.active
    }
}

/// `{ tier, completed, progress, next }` from the rewarded referral count,
/// verified contribution rows and the roster row.
pub fn ambassador_progress(
    activated_referrals: i64,
    contributions: &[Json],
    roster: Option<&Roster>,
) -> Json {
    let mut verified: Vec<String> = Vec::new();
    for row in contributions {
        let mission = row
            .get("mission")
            .and_then(Json::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if MISSION_KEYS.contains(&mission.as_str())
            && mission != "referrals"
            && !verified.iter().any(|seen| seen == &mission)
        {
            verified.push(mission);
        }
    }
    if activated_referrals >= REFERRAL_MISSION_TARGET {
        verified.push("referrals".to_string());
    }
    // Completed keys are reported in MISSION_KEYS order, like the Node filter.
    let completed: Vec<&str> = MISSION_KEYS
        .iter()
        .copied()
        .filter(|key| verified.iter().any(|seen| seen == key))
        .collect();

    let role = roster
        .map(|roster| roster.role.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let on_roster = roster
        .map(|roster| roster.is_active() && AMBASSADOR_ROLES.contains(&role.as_str()))
        .unwrap_or(false);
    let city = if on_roster {
        roster.map(|roster| roster.city.trim().to_string()).unwrap_or_default()
    } else {
        String::new()
    };

    let mission_count = completed.len() as i64;
    let mut tier = "collector";
    if on_roster || mission_count >= AMBASSADOR_MISSIONS {
        tier = "ambassador";
    }
    if tier == "ambassador"
        && mission_count >= SENIOR_MISSIONS
        && activated_referrals >= SENIOR_REFERRALS
    {
        tier = "senior";
    }
    if tier != "collector" && !city.is_empty() {
        tier = "city";
    }

    let next = match tier {
        "collector" => json!({
            "tier": "ambassador",
            "missionsLeft": AMBASSADOR_MISSIONS - mission_count,
        }),
        "ambassador" => json!({
            "tier": "senior",
            "missionsLeft": (SENIOR_MISSIONS - mission_count).max(0),
            "referralsLeft": (SENIOR_REFERRALS - activated_referrals).max(0),
        }),
        _ => Json::Null,
    };

    json!({
        "tier": tier,
        "city": city,
        "completed": completed,
        "activatedReferrals": activated_referrals,
        "referralTarget": REFERRAL_MISSION_TARGET,
        "onRoster": on_roster,
        "founder": on_roster && role == "founder_ambassador",
        "next": next,
    })
}

/// Build a roster row from a SQL row (the `marketplace_associates` shape).
pub fn roster_from_row(row: &Json) -> Roster {
    let active = row
        .get("active")
        .map(|value| value.as_bool().unwrap_or(true))
        .unwrap_or(true);
    Roster {
        present: true,
        active,
        role: row
            .get("role")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string(),
        city: row
            .get("city")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contribution(mission: &str) -> Json {
        json!({ "mission": mission })
    }

    #[test]
    fn a_new_account_is_a_collector() {
        let progress = ambassador_progress(0, &[], None);
        assert_eq!(progress["tier"], json!("collector"));
        assert_eq!(progress["completed"], json!([]));
        assert_eq!(progress["next"]["tier"], json!("ambassador"));
        assert_eq!(progress["next"]["missionsLeft"], json!(3));
        assert_eq!(progress["founder"], json!(false));
        assert_eq!(progress["onRoster"], json!(false));
    }

    #[test]
    fn three_verified_missions_make_an_ambassador() {
        let contributions = [
            contribution("content"),
            contribution("bug_report"),
            contribution("feedback"),
        ];
        let progress = ambassador_progress(0, &contributions, None);
        assert_eq!(progress["tier"], json!("ambassador"));
        // Completed keys come back in MISSION_KEYS order.
        assert_eq!(
            progress["completed"],
            json!(["content", "bug_report", "feedback"])
        );
        assert_eq!(progress["next"]["tier"], json!("senior"));
        assert_eq!(progress["next"]["missionsLeft"], json!(2));
        assert_eq!(progress["next"]["referralsLeft"], json!(10));
    }

    #[test]
    fn three_activated_referrals_count_as_the_referral_mission() {
        let progress = ambassador_progress(3, &[], None);
        assert_eq!(progress["completed"], json!(["referrals"]));
        assert_eq!(progress["activatedReferrals"], json!(3));
        assert_eq!(progress["tier"], json!("collector"));
        // A stored referrals contribution row must not double count.
        let progress = ambassador_progress(3, &[contribution("referrals")], None);
        assert_eq!(progress["completed"], json!(["referrals"]));
    }

    #[test]
    fn senior_needs_five_missions_and_ten_referrals() {
        let contributions = [
            contribution("content"),
            contribution("bug_report"),
            contribution("seller_onboard"),
            contribution("community_event"),
            contribution("feedback"),
        ];
        // Five missions but only 9 referrals: still an ambassador.
        let progress = ambassador_progress(9, &contributions, None);
        assert_eq!(progress["tier"], json!("ambassador"));
        assert_eq!(progress["next"]["referralsLeft"], json!(1));
        // Ten referrals promotes.
        let progress = ambassador_progress(10, &contributions, None);
        assert_eq!(progress["tier"], json!("senior"));
        assert_eq!(progress["next"], Json::Null);
    }

    #[test]
    fn roster_membership_promotes_and_the_city_tier_wins() {
        let roster = Roster {
            present: true,
            active: true,
            role: "ambassador".into(),
            city: "Rome".into(),
        };
        let progress = ambassador_progress(0, &[], Some(&roster));
        assert_eq!(progress["tier"], json!("city"));
        assert_eq!(progress["city"], json!("Rome"));
        assert_eq!(progress["onRoster"], json!(true));
        assert_eq!(progress["founder"], json!(false));
        assert_eq!(progress["next"], Json::Null);

        let founder = Roster {
            present: true,
            active: true,
            role: "founder_ambassador".into(),
            city: String::new(),
        };
        let progress = ambassador_progress(0, &[], Some(&founder));
        assert_eq!(progress["tier"], json!("ambassador"));
        assert_eq!(progress["founder"], json!(true));
        assert_eq!(progress["city"], json!(""));
    }

    #[test]
    fn an_inactive_or_unknown_role_is_not_on_the_roster() {
        let inactive = Roster {
            present: true,
            active: false,
            role: "ambassador".into(),
            city: "Rome".into(),
        };
        let progress = ambassador_progress(0, &[], Some(&inactive));
        assert_eq!(progress["onRoster"], json!(false));
        assert_eq!(progress["tier"], json!("collector"));

        let other_role = Roster {
            present: true,
            active: true,
            role: "associate".into(),
            city: "Rome".into(),
        };
        let progress = ambassador_progress(0, &[], Some(&other_role));
        assert_eq!(progress["onRoster"], json!(false));
    }

    #[test]
    fn unknown_missions_are_ignored() {
        let contributions = [
            contribution("not_a_mission"),
            contribution(""),
            contribution("content"),
        ];
        let progress = ambassador_progress(0, &contributions, None);
        assert_eq!(progress["completed"], json!(["content"]));
    }

    #[test]
    fn roster_rows_default_active_to_true() {
        let roster = roster_from_row(&json!({ "role": "Ambassador", "city": "Rome" }));
        assert!(roster.is_active());
        let inactive = roster_from_row(&json!({ "role": "ambassador", "active": false }));
        assert!(!inactive.is_active());
        // A missing roster row is not a roster.
        assert!(!Roster::default().is_active());
    }
}
