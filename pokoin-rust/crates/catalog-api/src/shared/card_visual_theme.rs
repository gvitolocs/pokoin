//! Port of `_card_visual_theme.js` — card visual theme v1.
//!
//! Derives the semantic card-desk palette from the persisted leftover
//! illustration shade (`marketplace_leftover_art_shades`). Validity is keyed
//! on the artwork's content identity (`artwork_identity`, sha256 of the
//! canonical leftover JPEG), never on the shade: a persisted theme row is
//! trusted only when its identity equals the current one.

use serde_json::{json, Map, Value};

pub const THEME_VERSION: &str = "v1";

/// The seven semantic hex fields, in pack order.
pub const THEME_HEX_FIELDS: [&str; 7] = [
    "background",
    "surface",
    "surfaceRaised",
    "hero",
    "heroBorder",
    "border",
    "tint",
];

/// Persisted rows are snake_case; the served payload is camelCase.
fn row_column(field: &str) -> &str {
    match field {
        "surfaceRaised" => "surface_raised",
        "heroBorder" => "hero_border",
        other => other,
    }
}

fn is_hex6(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

// sRGB ↔ OKLCH, Björn Ottosson's reference matrices.
const SRGB_TO_LMS: [[f64; 3]; 3] = [
    [0.4122214708, 0.5363325363, 0.0514459929],
    [0.2119034982, 0.6806995451, 0.1073969566],
    [0.0883024619, 0.2817188376, 0.6299787005],
];
const LMS_TO_OKLAB: [[f64; 3]; 3] = [
    [0.2104542553, 0.793617785, -0.0040720468],
    [1.9779984951, -2.428592205, 0.4505937099],
    [0.0259040371, 0.7827717662, -0.808675766],
];
const OKLAB_TO_LMS: [[f64; 3]; 3] = [
    [1.0, 0.3963377774, 0.2158037573],
    [1.0, -0.1055613458, -0.0638541728],
    [1.0, -0.0894841775, -1.291485548],
];
const LMS_TO_SRGB: [[f64; 3]; 3] = [
    [4.0767416621, -3.3077115913, 0.2309699292],
    [-1.2684380046, 2.6097574011, -0.3413193965],
    [-0.0041960863, -0.7034186147, 1.707614701],
];

fn dot(matrix: &[[f64; 3]; 3], a: f64, b: f64, c: f64) -> [f64; 3] {
    [
        matrix[0][0] * a + matrix[0][1] * b + matrix[0][2] * c,
        matrix[1][0] * a + matrix[1][1] * b + matrix[1][2] * c,
        matrix[2][0] * a + matrix[2][1] * b + matrix[2][2] * c,
    ]
}

fn srgb_to_linear(value: f64) -> f64 {
    let v = value / 255.0;
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(value: f64) -> i64 {
    let v = if value <= 0.0031308 {
        value * 12.92
    } else {
        1.055 * value.powf(1.0 / 2.4) - 0.055
    };
    (v * 255.0).round().clamp(0.0, 255.0) as i64
}

/// `hexToRgb` — `[r, g, b]` for `#rrggbb`.
pub fn hex_to_rgb(hex: &str) -> Option<[i64; 3]> {
    if !is_hex6(hex) {
        return None;
    }
    let body = &hex[1..];
    Some([
        i64::from_str_radix(&body[0..2], 16).ok()?,
        i64::from_str_radix(&body[2..4], 16).ok()?,
        i64::from_str_radix(&body[4..6], 16).ok()?,
    ])
}

fn rgb_to_hex(rgb: [i64; 3]) -> String {
    let channel = |value: i64| format!("{:02x}", value.clamp(0, 255));
    format!("#{}{}{}", channel(rgb[0]), channel(rgb[1]), channel(rgb[2]))
}

/// `hexToOklch(hex)` — `{ l, c, h }` or null on a non-hex input.
pub fn hex_to_oklch(hex: &str) -> Option<[f64; 3]> {
    let rgb = hex_to_rgb(hex)?;
    let linear: [f64; 3] = [
        srgb_to_linear(rgb[0] as f64),
        srgb_to_linear(rgb[1] as f64),
        srgb_to_linear(rgb[2] as f64),
    ];
    let lms = dot(&SRGB_TO_LMS, linear[0], linear[1], linear[2]).map(|v| v.cbrt());
    let lab = dot(&LMS_TO_OKLAB, lms[0], lms[1], lms[2]);
    let chroma = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
    let mut hue = lab[2].atan2(lab[1]) * 180.0 / std::f64::consts::PI;
    if hue < 0.0 {
        hue += 360.0;
    }
    Some([lab[0], chroma, hue])
}

/// `oklchToHex({ l, c, h })`.
pub fn oklch_to_hex(l: f64, c: f64, h: f64) -> String {
    let rad = h * std::f64::consts::PI / 180.0;
    let a = rad.cos() * c;
    let b = rad.sin() * c;
    let lms_prime = dot(&OKLAB_TO_LMS, l, a, b);
    let lms = lms_prime.map(|v| v * v * v);
    let srgb = dot(&LMS_TO_SRGB, lms[0], lms[1], lms[2]);
    rgb_to_hex([
        linear_to_srgb(srgb[0]),
        linear_to_srgb(srgb[1]),
        linear_to_srgb(srgb[2]),
    ])
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

fn shade(level: [f64; 3]) -> String {
    oklch_to_hex(level[0], level[1], level[2])
}

fn relative_luminance(hex: &str) -> f64 {
    let Some(rgb) = hex_to_rgb(hex) else {
        return 0.0;
    };
    0.2126 * srgb_to_linear(rgb[0] as f64)
        + 0.7152 * srgb_to_linear(rgb[1] as f64)
        + 0.0722 * srgb_to_linear(rgb[2] as f64)
}

/// WCAG 2 contrast ratio (white text is the desk's ink on these surfaces).
pub fn contrast_ratio(hex_a: &str, hex_b: &str) -> f64 {
    let a = relative_luminance(hex_a);
    let b = relative_luminance(hex_b);
    let (hi, lo) = if a >= b { (a, b) } else { (b, a) };
    (hi + 0.05) / (lo + 0.05)
}

const WHITE: &str = "#ffffff";

/// `buildVisualTheme(artShade, artworkIdentity)` — the semantic desk palette
/// from a leftover shade, stamped with the artwork identity.
pub fn build_visual_theme(art_shade: &str, artwork_identity: &str) -> Option<Value> {
    let source = hex_to_oklch(art_shade)?;
    // A near-gray scan (Colorless / Normal) is achromatic. Hue 265 plus a
    // chroma floor painted the page blue under a gray header tile.
    let neutral = source[1] < 0.02;
    let hue = if neutral { 0.0 } else { source[2] };
    let chroma = source[1];
    // Chromatic artwork keeps a floor so a dark yellow does not fall back to
    // blue-black. A 0.03 cap on a yellow scan collapsed to the same blue-black.
    let kept = if neutral {
        0.0
    } else {
        (chroma * 2.2).clamp(0.055, 0.11)
    };
    let background = [clamp(source[0] * 0.5, 0.15, 0.2), kept, hue];
    let surface = [
        clamp(background[0] + 0.04, 0.19, 0.24),
        (kept * 1.15).min(0.12),
        hue,
    ];
    let surface_raised = [
        clamp(surface[0] + 0.018, 0.21, 0.255),
        (kept * 1.2).min(0.125),
        hue,
    ];
    let mut hero = [
        clamp(source[0] + 0.04, 0.34, 0.52),
        if neutral {
            0.0
        } else {
            (chroma * 1.35).min(0.115)
        },
        hue,
    ];
    let mut guard = 0;
    while guard < 8 && contrast_ratio(&shade(hero), WHITE) < 4.5 {
        hero[0] -= 0.025;
        guard += 1;
    }
    let tint = [
        clamp(hero[0] + 0.05, 0.4, 0.55),
        if neutral { 0.0 } else { chroma.min(0.075) },
        hue,
    ];
    let border = [
        0.34,
        if neutral {
            0.0
        } else {
            (chroma * 0.5).min(0.035)
        },
        hue,
    ];
    let hero_border = [
        0.45,
        if neutral {
            0.0
        } else {
            (chroma * 0.9).min(0.09)
        },
        hue,
    ];

    let mut theme = Map::new();
    theme.insert("version".into(), json!(THEME_VERSION));
    theme.insert("artworkShade".into(), json!(art_shade.to_lowercase()));
    theme.insert("artworkIdentity".into(), json!(artwork_identity));
    theme.insert("hue".into(), js::round3(hue));
    theme.insert("chroma".into(), js::round3(chroma));
    theme.insert("background".into(), json!(shade(background)));
    theme.insert("surface".into(), json!(shade(surface)));
    theme.insert("surfaceRaised".into(), json!(shade(surface_raised)));
    theme.insert("hero".into(), json!(shade(hero)));
    theme.insert("heroBorder".into(), json!(shade(hero_border)));
    theme.insert("border".into(), json!(shade(border)));
    theme.insert("tint".into(), json!(shade(tint)));
    Some(Value::Object(theme))
}

use super::js;

fn row_hex(row: &Value, field: &str) -> String {
    let value = js::get(row, row_column(field));
    let Some(value) = value else {
        return String::new();
    };
    let text = js::string_or_empty(Some(value)).to_lowercase();
    if is_hex6(&text) {
        text
    } else {
        String::new()
    }
}

/// `visualThemeForShade(row, artShade, artworkIdentity)` — the persisted row
/// only when its artwork identity equals the current one and the theme
/// version is current; otherwise re-derived. `None` when there is no usable
/// current shade.
pub fn visual_theme_for_shade(
    row: Option<&Value>,
    art_shade: &str,
    artwork_identity: &str,
) -> Option<Value> {
    let normalized_shade = art_shade.to_lowercase();
    if !is_hex6(&normalized_shade) {
        return None;
    }
    let current_identity = artwork_identity;
    if let Some(row) = row.filter(|row| row.is_object()) {
        let version = js::string_or_empty(js::get(row, "version"));
        let row_identity = js::string_or_empty(
            js::get(row, "artwork_identity").or_else(|| js::get(row, "artworkIdentity")),
        );
        let hexes: Vec<String> = THEME_HEX_FIELDS
            .iter()
            .map(|field| row_hex(row, field))
            .collect();
        if version == THEME_VERSION
            && !current_identity.is_empty()
            && row_identity == current_identity
            && hexes.iter().all(|hex| !hex.is_empty())
        {
            let mut theme = Map::new();
            theme.insert("version".into(), json!(version));
            theme.insert("artworkShade".into(), json!(normalized_shade));
            theme.insert("artworkIdentity".into(), json!(row_identity));
            for (index, field) in THEME_HEX_FIELDS.iter().enumerate() {
                theme.insert((*field).to_string(), json!(hexes[index]));
            }
            let hue = js::number(js::get(row, "hue"));
            let chroma = js::number(js::get(row, "chroma"));
            theme.insert(
                "hue".into(),
                js::js_json_number(if hue.is_finite() { hue } else { 0.0 }),
            );
            theme.insert(
                "chroma".into(),
                js::js_json_number(if chroma.is_finite() { chroma } else { 0.0 }),
            );
            return Some(Value::Object(theme));
        }
    }
    build_visual_theme(&normalized_shade, current_identity)
}

/// `packVisualTheme(theme)` — `v1` + the seven hexes concatenated (44 chars).
pub fn pack_visual_theme(theme: Option<&Value>) -> String {
    let Some(theme) = theme else {
        return String::new();
    };
    if js::string_or_empty(js::get(theme, "version")) != THEME_VERSION {
        return String::new();
    }
    let mut packed = THEME_VERSION.to_string();
    for field in THEME_HEX_FIELDS {
        let hex = js::string_or_empty(js::get(theme, field)).to_lowercase();
        if !is_hex6(&hex) {
            return String::new();
        }
        packed.push_str(&hex[1..]);
    }
    packed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hex_round_trips_through_oklch() {
        for hex in ["#123456", "#ffffff", "#000000", "#f2a3c1", "#0f0f0f"] {
            let oklch = hex_to_oklch(hex).unwrap();
            let back = oklch_to_hex(oklch[0], oklch[1], oklch[2]);
            let round = hex_to_oklch(&back).unwrap();
            assert!((oklch[0] - round[0]).abs() < 0.005, "{hex} -> {back}");
            assert!((oklch[1] - round[1]).abs() < 0.005, "{hex} -> {back}");
        }
        assert_eq!(hex_to_rgb("#12g456"), None);
        assert_eq!(hex_to_rgb("123456"), None);
    }

    #[test]
    fn contrast_ratio_matches_wcag() {
        assert!((contrast_ratio("#000000", "#ffffff") - 21.0).abs() < 0.01);
        // #777777 is 4.48:1 — below AA; #666666 clears it.
        assert!(contrast_ratio("#777777", "#ffffff") < 4.5);
        assert!(contrast_ratio("#666666", "#ffffff") > 4.5);
    }

    #[test]
    fn themes_carry_the_semantic_fields() {
        let theme = build_visual_theme("#5A3E9B", "abc").unwrap();
        assert_eq!(theme["version"], json!("v1"));
        assert_eq!(theme["artworkShade"], json!("#5a3e9b"));
        assert_eq!(theme["artworkIdentity"], json!("abc"));
        for field in THEME_HEX_FIELDS {
            assert!(is_hex6(theme[field].as_str().unwrap()), "{field}");
        }
        assert!(theme["hue"].as_f64().unwrap() > 250.0);
        // White text stays readable on hero.
        assert!(contrast_ratio(theme["hero"].as_str().unwrap(), WHITE) >= 4.4);
    }

    #[test]
    fn near_gray_shades_are_achromatic() {
        let theme = build_visual_theme("#808080", "").unwrap();
        assert_eq!(theme["hue"], json!(0));
        assert_eq!(theme["chroma"], json!(0));
    }

    #[test]
    fn invalid_shades_produce_no_theme() {
        assert!(build_visual_theme("nope", "").is_none());
        assert!(visual_theme_for_shade(None, "zzz", "").is_none());
    }

    #[test]
    fn persisted_rows_are_trusted_only_when_fresh() {
        let theme = build_visual_theme("#5A3E9B", "ident-1").unwrap();
        let packed = pack_visual_theme(Some(&theme));
        assert_eq!(packed.len(), 44);
        assert!(packed.starts_with("v1"));

        // Round trip through the persisted-row shape.
        let row = json!({
            "version": "v1",
            "artwork_identity": "ident-1",
            "hue": theme["hue"],
            "chroma": theme["chroma"],
            "background": theme["background"],
            "surface": theme["surface"],
            "surface_raised": theme["surfaceRaised"],
            "hero": theme["hero"],
            "hero_border": theme["heroBorder"],
            "border": theme["border"],
            "tint": theme["tint"],
        });
        let restored = visual_theme_for_shade(Some(&row), "#5a3e9b", "ident-1").unwrap();
        assert_eq!(restored["background"], theme["background"]);
        assert_eq!(restored["surfaceRaised"], theme["surfaceRaised"]);
        assert_eq!(pack_visual_theme(Some(&restored)), packed);

        // A stale identity re-derives from the shade.
        let stale = visual_theme_for_shade(Some(&row), "#5a3e9b", "ident-2").unwrap();
        assert_eq!(stale["background"], theme["background"]);
        assert_eq!(stale["artworkIdentity"], json!("ident-2"));

        // Rows without an identity are unverifiable and re-derive.
        let unverified =
            visual_theme_for_shade(Some(&json!({"version": "v1"})), "#5a3e9b", "ident-1").unwrap();
        assert_eq!(unverified["background"], theme["background"]);

        assert_eq!(pack_visual_theme(Some(&json!({"version": "v0"}))), "");
        assert_eq!(pack_visual_theme(None), "");
    }
}
