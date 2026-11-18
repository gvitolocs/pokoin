//! Seller Portal map. The defaults are a best guess, not a calibrated portal.

use anyhow::Context;
use serde::{Deserialize, Serialize};

/// Paths are relative to [`PortalConfig::base_url`] unless they are absolute.
/// `{query}`, `{sku}`, `{page}`, and `{order}` are replaced when the URL is built.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalPaths {
    pub home: String,
    pub login: String,
    /// Substrings of a URL that mean the seller is on a sign-in page.
    pub login_markers: Vec<String>,
    pub inventory_search: String,
    pub sku: String,
    pub orders: String,
    pub order: String,
}

/// CSS selectors and the attribute names that carry a SKU id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalSelectors {
    pub login_form: String,
    pub signed_in_marker: String,
    pub result_row: String,
    pub row_sku_attribute: String,
    pub condition: String,
    pub printing: String,
    pub language: String,
    pub quantity_input: String,
    pub price_input: String,
    pub save_button: String,
    pub saved_marker: String,
    pub error_marker: String,
    pub order_row: String,
    pub order_id: String,
    pub order_date: String,
    pub order_status: String,
    pub order_buyer: String,
    pub line_row: String,
    pub line_sku_attribute: String,
    pub line_name: String,
    pub line_quantity: String,
    pub line_price: String,
    pub ship_name: String,
    pub ship_line1: String,
    pub ship_line2: String,
    pub ship_city: String,
    pub ship_state: String,
    pub ship_zip: String,
    pub ship_country: String,
    pub shipping_method: String,
    pub order_total: String,
    pub next_page: String,
    pub captcha: Vec<String>,
}

/// Where the Seller Portal lives and how to find the controls on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalConfig {
    #[serde(default)]
    pub note: String,
    pub base_url: String,
    pub allowed_origins: Vec<String>,
    pub paths: PortalPaths,
    pub selectors: PortalSelectors,
}

impl PortalConfig {
    /// Best-guess Seller Portal map.
    ///
    /// **Unverified until calibrated against the live Portal by the seller.**
    /// Nothing in the test suite opens these origins. Copy
    /// `docs/tcgplayer-portal-config.example.json`, fix the paths and selectors
    /// `check` could not find, and pass that file with `--portal-config`.
    pub fn tcgplayer_defaults() -> Self {
        Self {
            note: "Selectors and paths are unverified until calibrated against the live Portal by the seller.".to_string(),
            base_url: "https://store.tcgplayer.com".to_string(),
            allowed_origins: vec![
                "https://store.tcgplayer.com".to_string(),
                "https://sellerportal.tcgplayer.com".to_string(),
                "https://id.tcgplayer.com".to_string(),
            ],
            paths: PortalPaths {
                home: "/".to_string(),
                login: "/login".to_string(),
                login_markers: vec!["/login".to_string(), "/signin".to_string(), "id.tcgplayer.com".to_string()],
                inventory_search: "/search?q={query}".to_string(),
                sku: "/sku/{sku}".to_string(),
                orders: "/orders?page={page}".to_string(),
                order: "/order/{order}".to_string(),
            },
            selectors: PortalSelectors {
                login_form: "form[data-login]".to_string(),
                signed_in_marker: "[data-signed-in]".to_string(),
                result_row: "tr.product-row".to_string(),
                row_sku_attribute: "data-sku".to_string(),
                condition: "[data-condition]".to_string(),
                printing: "[data-printing]".to_string(),
                language: "[data-language]".to_string(),
                quantity_input: "input[name='quantity']".to_string(),
                price_input: "input[name='price']".to_string(),
                save_button: "button[data-save]".to_string(),
                saved_marker: "[data-saved]".to_string(),
                error_marker: "[data-error]".to_string(),
                order_row: "[data-order]".to_string(),
                order_id: "[data-order-id]".to_string(),
                order_date: "[data-order-date]".to_string(),
                order_status: "[data-order-status]".to_string(),
                order_buyer: "[data-order-buyer]".to_string(),
                line_row: "[data-line]".to_string(),
                line_sku_attribute: "data-sku".to_string(),
                line_name: "[data-line-name]".to_string(),
                line_quantity: "[data-line-qty]".to_string(),
                line_price: "[data-line-price]".to_string(),
                ship_name: "[data-ship-name]".to_string(),
                ship_line1: "[data-ship-line1]".to_string(),
                ship_line2: "[data-ship-line2]".to_string(),
                ship_city: "[data-ship-city]".to_string(),
                ship_state: "[data-ship-state]".to_string(),
                ship_zip: "[data-ship-zip]".to_string(),
                ship_country: "[data-ship-country]".to_string(),
                shipping_method: "[data-shipping-method]".to_string(),
                order_total: "[data-order-total]".to_string(),
                next_page: "a[data-next]".to_string(),
                captcha: vec![
                    "iframe[src*='recaptcha']".to_string(),
                    "iframe[src*='hcaptcha']".to_string(),
                    "iframe[src*='turnstile']".to_string(),
                    "iframe[src*='captcha']".to_string(),
                    "iframe[src*='challenges.cloudflare']".to_string(),
                ],
            },
        }
    }

    pub fn load(path: &std::path::Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("could not read {}", path.display()))?;
        serde_json::from_str(&text).with_context(|| format!("could not parse {}", path.display()))
    }

    pub fn url(&self, template: &str, pairs: &[(&str, &str)]) -> String {
        let mut path = template.to_string();
        for (key, value) in pairs {
            path = path.replace(&format!("{{{key}}}"), &encode_component(value));
        }
        if path.starts_with("http://") || path.starts_with("https://") {
            return path;
        }
        let base = self.base_url.trim_end_matches('/');
        if path.starts_with('/') {
            format!("{base}{path}")
        } else {
            format!("{base}/{path}")
        }
    }
}

fn encode_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn example_config_matches_the_defaults() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/tcgplayer-portal-config.example.json");
        let loaded = PortalConfig::load(&path).expect("example config");
        assert_eq!(loaded, PortalConfig::tcgplayer_defaults());
    }

    #[test]
    fn templates_fill_and_join_the_base() {
        let config = PortalConfig::tcgplayer_defaults();
        let url = config.url(&config.paths.inventory_search, &[("query", "Jungle 51/64")]);
        assert!(url.contains("Jungle%2051"));
        assert!(url.starts_with(&config.base_url));
    }
}
