//! Time helpers. RFC3339 formatting/parsing from unix milliseconds and
//! `time` crate values — used by Firestore, JWT, and PG timestamps.

use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, PrimitiveDateTime, UtcOffset};

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Milliseconds → RFC3339 with milliseconds and Z, the shape Node's
/// `new Date(x).toISOString()` produces ("2026-10-08T12:00:00.000Z").
pub fn iso_from_ms(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000) as u32;
    let dt = OffsetDateTime::from_unix_timestamp(seconds)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
        .replace_nanosecond(millis * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    let base = dt.format(&Rfc3339).unwrap_or_default();
    // RFC3339 from time gives "2026-10-08T12:00:00.000Z" already when ns present.
    base
}

pub fn iso_from_offset(dt: OffsetDateTime) -> String {
    dt.to_utc().format(&Rfc3339).unwrap_or_default()
}

pub fn iso_from_primitive(dt: PrimitiveDateTime) -> String {
    dt.assume_utc().format(&Rfc3339).unwrap_or_default()
}

/// Parse the ISO strings Node writes (Firestore `toDate().toISOString()` or
/// pre-serialized strings) back to unix ms; None when unparseable.
pub fn ms_from_iso(value: &str) -> Option<i64> {
    OffsetDateTime::parse(value, &Rfc3339)
        .ok()
        .map(|dt| dt.unix_timestamp() * 1000 + i64::from(dt.nanosecond()) / 1_000_000)
        .or_else(|| OffsetDateTime::parse(value, &time::format_description::well_known::Iso8601::DEFAULT).ok().map(|dt| dt.unix_timestamp() * 1000))
}

/// `utcDayKey` — YYYY-MM-DD slice of an ISO timestamp (Portfolio/1-DR keys).
pub fn utc_day_key(value: &str) -> String {
    value.get(..10).unwrap_or_default().to_string()
}

/// Local-noon-free UTC "today" day key from unix ms.
pub fn utc_day_key_from_ms(ms: i64) -> String {
    iso_from_ms(ms).get(..10).unwrap_or_default().to_string()
}

/// OffsetDateTime with UTC — small helper used by SigV4 and JWT.
pub fn utc_now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

pub fn utc_offset_zero() -> UtcOffset {
    UtcOffset::UTC
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trip_shape() {
        let iso = iso_from_ms(1_768_000_000_000);
        assert_eq!(iso, "2026-01-09T23:06:40Z", "got {iso}");
        assert!(iso.ends_with('Z'));
        assert_eq!(ms_from_iso(&iso), Some(1_768_000_000_000));
        assert_eq!(ms_from_iso("not-a-date"), None);
    }

    #[test]
    fn day_keys() {
        assert_eq!(utc_day_key("2026-10-08T10:00:00.000Z"), "2026-10-08");
        assert_eq!(utc_day_key_from_ms(0), "1970-01-01");
    }
}
