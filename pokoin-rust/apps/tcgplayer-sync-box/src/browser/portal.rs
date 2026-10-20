//! `BrowserPortal` drives one Chrome page through the Seller Portal map.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::cdp::Cdp;
use super::config::PortalConfig;
use super::guard::{self, FieldAttrs};
use super::launch::{self, Chrome, LaunchOptions};
use crate::portal::{Portal, PortalError, PortalWrite};
use crate::ListingTarget;

struct Live {
    chrome: Chrome,
    cdp: Cdp,
}

/// One Chrome profile and one page. The session is relaunched if Chrome exits.
pub struct BrowserPortal {
    options: LaunchOptions,
    live: Mutex<Option<Live>>,
}

impl BrowserPortal {
    pub async fn launch(options: LaunchOptions) -> anyhow::Result<Self> {
        let portal = Self { options, live: Mutex::new(None) };
        drop(portal.ensure().await?);
        Ok(portal)
    }

    /// Read-only probe. A challenge or login page stops the walk. `sku` also
    /// opens that edit page and reports its fields. Nothing is typed or saved.
    pub async fn check(&self, sku: Option<&str>) -> anyhow::Result<String> {
        let guard = self.ensure().await?;
        let cdp = &guard.as_ref().expect("session").cdp;
        let config = &self.options.config;
        let mut lines = Vec::new();
        let home = config.url(&config.paths.home, &[]);
        lines.push(format!("home: {home}"));
        if !opened(cdp, config, &home, &mut lines).await? {
            return Ok(lines.join("\n"));
        }
        lines.extend(session_report(cdp, config).await?);
        lines.extend(probe_group(cdp, "home", &[("login form", &config.selectors.login_form), ("signed-in marker", &config.selectors.signed_in_marker)]).await?);
        for (index, selector) in config.selectors.captcha.iter().enumerate() {
            let found = present(cdp, selector).await.unwrap_or(false);
            lines.push(format!("home captcha selector {}: {}", index + 1, if found { "found" } else { "missing" }));
        }
        if stopped(cdp, config, &mut lines).await? {
            return Ok(lines.join("\n"));
        }
        let search = config.url(&config.paths.inventory_search, &[("query", "pikachu")]);
        lines.push(format!("search: {search}"));
        if !opened(cdp, config, &search, &mut lines).await? || stopped(cdp, config, &mut lines).await? {
            return Ok(lines.join("\n"));
        }
        lines.extend(
            probe_group(
                cdp,
                "search",
                &[
                    ("result row", &config.selectors.result_row),
                    ("condition", &config.selectors.condition),
                    ("printing", &config.selectors.printing),
                    ("language", &config.selectors.language),
                ],
            )
            .await?,
        );
        let orders = config.url(&config.paths.orders, &[("page", "1")]);
        lines.push(format!("orders: {orders}"));
        if !opened(cdp, config, &orders, &mut lines).await? || stopped(cdp, config, &mut lines).await? {
            return Ok(lines.join("\n"));
        }
        lines.extend(
            probe_group(
                cdp,
                "orders",
                &[
                    ("order row", &config.selectors.order_row),
                    ("order id", &config.selectors.order_id),
                    ("order date", &config.selectors.order_date),
                    ("order status", &config.selectors.order_status),
                    ("order buyer", &config.selectors.order_buyer),
                    ("next page", &config.selectors.next_page),
                ],
            )
            .await?,
        );
        if let Some(sku) = sku.filter(|sku| !sku.is_empty()) {
            let page = config.url(&config.paths.sku, &[("sku", sku)]);
            lines.push(format!("sku: {page}"));
            if !opened(cdp, config, &page, &mut lines).await? || stopped(cdp, config, &mut lines).await? {
                return Ok(lines.join("\n"));
            }
            let selectors = &config.selectors;
            lines.extend(
                probe_group(
                    cdp,
                    "sku",
                    &[("quantity input", &selectors.quantity_input), ("price input", &selectors.price_input), ("save button", &selectors.save_button)],
                )
                .await?,
            );
            let quantity = value_of(cdp, &selectors.quantity_input).await.unwrap_or_default();
            let price = value_of(cdp, &selectors.price_input).await.unwrap_or_default();
            lines.push(format!("quantity: {quantity}"));
            lines.push(format!("price: {price}"));
        }
        Ok(lines.join("\n"))
    }

    /// Open the login page and wait until the signed-in marker appears. Nothing is typed.
    pub async fn wait_for_sign_in(&self) -> anyhow::Result<()> {
        let guard = self.ensure().await?;
        let cdp = &guard.as_ref().expect("session").cdp;
        let config = &self.options.config;
        let login = config.url(&config.paths.login, &[]);
        open_allowed(cdp, config, &login).await?;
        let deadline = Instant::now() + Duration::from_secs(30 * 60);
        loop {
            if let Some(reason) = challenge(cdp, config).await? {
                anyhow::bail!("blocked: {reason} — open the Chrome window and clear it");
            }
            if present(cdp, &config.selectors.signed_in_marker).await? {
                return Ok(());
            }
            if Instant::now() >= deadline {
                anyhow::bail!("timed out waiting for the signed-in marker");
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    pub async fn navigate(&self, url: &str) -> Result<(), PortalError> {
        let guard = self.ensure().await?;
        let cdp = &guard.as_ref().expect("session").cdp;
        open_allowed(cdp, &self.options.config, url).await
    }

    pub async fn type_into(&self, selector: &str, text: &str) -> Result<(), PortalError> {
        let guard = self.ensure().await?;
        let cdp = &guard.as_ref().expect("session").cdp;
        type_into(cdp, selector, text).await
    }

    pub async fn input_value(&self, selector: &str) -> Result<String, PortalError> {
        let guard = self.ensure().await?;
        let cdp = &guard.as_ref().expect("session").cdp;
        value_of(cdp, selector).await
    }

    pub async fn current_url(&self) -> Result<String, PortalError> {
        let guard = self.ensure().await?;
        guard.as_ref().expect("session").cdp.current_url().await
    }

    async fn ensure(&self) -> Result<tokio::sync::MutexGuard<'_, Option<Live>>, PortalError> {
        let mut guard = self.live.lock().await;
        let healthy = match guard.as_mut() {
            Some(live) => live.chrome.is_running() && live.cdp.alive(),
            None => false,
        };
        if !healthy {
            drop(guard.take());
            let chrome = launch::launch(&self.options).await.map_err(|error| PortalError::Transient(error.to_string()))?;
            let cdp = Cdp::attach(chrome.port).await?;
            *guard = Some(Live { chrome, cdp });
        }
        Ok(guard)
    }
}

#[async_trait]
impl Portal for BrowserPortal {
    async fn signed_in(&self) -> Result<bool, PortalError> {
        let guard = self.ensure().await?;
        let cdp = &guard.as_ref().expect("session").cdp;
        let config = &self.options.config;
        pace(&self.options).await;
        open_allowed(cdp, config, &config.url(&config.paths.home, &[])).await?;
        if let Some(reason) = challenge(cdp, config).await? {
            return Err(PortalError::Blocked(reason));
        }
        if login_page(cdp, config).await? {
            return Err(PortalError::SignedOut);
        }
        if present(cdp, &config.selectors.signed_in_marker).await? {
            return Ok(true);
        }
        Ok(false)
    }

    async fn set_listing(&self, target: &ListingTarget) -> Result<PortalWrite, PortalError> {
        let price = target.price_cents.ok_or_else(|| PortalError::Permanent("missing price".to_string()))?;
        require_qty(target.quantity)?;
        let guard = self.ensure().await?;
        let cdp = &guard.as_ref().expect("session").cdp;
        let config = &self.options.config;
        let query = search_query(target);
        pace(&self.options).await;
        open_allowed(cdp, config, &config.url(&config.paths.inventory_search, &[("query", &query)])).await?;
        gate(cdp, config).await?;
        let rows = read_results(cdp, config).await?;
        let matches: Vec<_> = rows
            .into_iter()
            .filter(|row| row_matches(row, target))
            .collect();
        let row = match matches.len() {
            0 => return Err(PortalError::Permanent("no matching TCGplayer SKU".to_string())),
            1 => matches.into_iter().next().expect("one match"),
            _ => return Err(PortalError::Permanent("ambiguous SKU".to_string())),
        };
        if row.sku.is_empty() {
            return Err(PortalError::Permanent("no matching TCGplayer SKU".to_string()));
        }
        write_sku(cdp, &self.options, &row.sku, Some(target.quantity), Some(price)).await
    }

    async fn set_quantity(&self, target: &ListingTarget) -> Result<PortalWrite, PortalError> {
        require_qty(target.quantity)?;
        let sku = require_sku(&target.external_id)?;
        let guard = self.ensure().await?;
        let cdp = &guard.as_ref().expect("session").cdp;
        write_sku(cdp, &self.options, sku, Some(target.quantity), None).await
    }

    async fn set_price(&self, target: &ListingTarget) -> Result<PortalWrite, PortalError> {
        let price = target.price_cents.ok_or_else(|| PortalError::Permanent("missing price".to_string()))?;
        let sku = require_sku(&target.external_id)?;
        let guard = self.ensure().await?;
        let cdp = &guard.as_ref().expect("session").cdp;
        write_sku(cdp, &self.options, sku, None, Some(price)).await
    }

    async fn fetch_orders(&self, since: Option<&str>) -> Result<Vec<Value>, PortalError> {
        let guard = self.ensure().await?;
        let cdp = &guard.as_ref().expect("session").cdp;
        let config = &self.options.config;
        let cutoff = since.and_then(cutoff_unix);
        let mut url = config.url(&config.paths.orders, &[("page", "1")]);
        let mut orders = Vec::new();
        for _ in 0..5 {
            pace(&self.options).await;
            open_allowed(cdp, config, &url).await?;
            gate(cdp, config).await?;
            let next = next_href(cdp, &config.selectors.next_page).await?;
            let rows = read_order_rows(cdp, config).await?;
            let mut stop = false;
            for row in rows {
                if let (Some(cutoff), Some(placed)) = (cutoff, row_unix(&row.date)) {
                    if placed < cutoff {
                        stop = true;
                        break;
                    }
                }
                pace(&self.options).await;
                let detail = config.url(&config.paths.order, &[("order", &row.id)]);
                open_allowed(cdp, config, &detail).await?;
                gate(cdp, config).await?;
                orders.push(read_order(cdp, config, &row).await?);
            }
            if stop {
                break;
            }
            match next {
                Some(next) => url = next,
                None => break,
            }
        }
        Ok(orders)
    }
}

async fn write_sku(cdp: &Cdp, options: &LaunchOptions, sku: &str, quantity: Option<i64>, price: Option<i64>) -> Result<PortalWrite, PortalError> {
    let config = &options.config;
    pace(options).await;
    let page = config.url(&config.paths.sku, &[("sku", sku)]);
    open_allowed(cdp, config, &page).await?;
    gate(cdp, config).await?;
    let selectors = &config.selectors;
    let qty_differs = match quantity {
        Some(quantity) => {
            wait_for(cdp, &selectors.quantity_input, Duration::from_secs(10)).await?;
            !same_qty(&value_of(cdp, &selectors.quantity_input).await?, quantity)
        }
        None => false,
    };
    let price_differs = match price {
        Some(cents) => {
            wait_for(cdp, &selectors.price_input, Duration::from_secs(10)).await?;
            parse_money(&value_of(cdp, &selectors.price_input).await?) != Some(cents)
        }
        None => false,
    };
    if !qty_differs && !price_differs {
        return Ok(PortalWrite { external_id: sku.to_string(), changed: false });
    }
    if let Some(quantity) = quantity {
        if qty_differs {
            type_into(cdp, &selectors.quantity_input, &quantity.to_string()).await?;
        }
    }
    if let Some(cents) = price {
        if price_differs {
            type_into(cdp, &selectors.price_input, &format_dollars(cents)).await?;
        }
    }
    pace(options).await;
    cdp.click(&selectors.save_button).await?;
    wait_for_save(cdp, selectors).await?;
    pace(options).await;
    cdp.reload().await?;
    gate(cdp, config).await?;
    if let Some(quantity) = quantity {
        let after = value_of(cdp, &selectors.quantity_input).await?;
        if !same_qty(&after, quantity) {
            return Err(PortalError::Transient("quantity did not stick".to_string()));
        }
    }
    if let Some(cents) = price {
        let after = value_of(cdp, &selectors.price_input).await?;
        if parse_money(&after) != Some(cents) {
            return Err(PortalError::Transient("price did not stick".to_string()));
        }
    }
    Ok(PortalWrite { external_id: sku.to_string(), changed: true })
}

async fn wait_for_save(cdp: &Cdp, selectors: &super::config::PortalSelectors) -> Result<(), PortalError> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if present(cdp, &selectors.error_marker).await? {
            let message = text_of(cdp, &selectors.error_marker).await?;
            let message = if message.is_empty() { "save failed".to_string() } else { message };
            return Err(PortalError::Transient(message));
        }
        if present(cdp, &selectors.saved_marker).await? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(PortalError::Transient("save was not confirmed".to_string()));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn type_into(cdp: &Cdp, selector: &str, text: &str) -> Result<(), PortalError> {
    let quoted = js(selector);
    let attrs = cdp
        .evaluate(&format!(
            "(() => {{ const el = document.querySelector({quoted}); if (!el) return null; return {{ type: el.getAttribute('type') || '', autocomplete: el.getAttribute('autocomplete') || '', name: el.getAttribute('name') || '', id: el.id || '', ariaLabel: el.getAttribute('aria-label') || '' }}; }})()"
        ))
        .await?;
    if attrs.is_null() {
        return Err(PortalError::Permanent(format!("field not found: {selector}")));
    }
    let field = FieldAttrs {
        type_name: attrs["type"].as_str().unwrap_or("").to_string(),
        autocomplete: attrs["autocomplete"].as_str().unwrap_or("").to_string(),
        name: attrs["name"].as_str().unwrap_or("").to_string(),
        id: attrs["id"].as_str().unwrap_or("").to_string(),
        aria_label: attrs["ariaLabel"].as_str().unwrap_or("").to_string(),
    };
    if guard::refuses_typing(&field) {
        return Err(guard::credential_error());
    }
    cdp.click(selector).await?;
    tokio::time::sleep(Duration::from_millis(30)).await;
    confirm_focus(cdp, selector).await?;
    cdp.select_all_and_clear().await?;
    let mut first = true;
    for chunk in chunks(text) {
        if !first {
            tokio::time::sleep(Duration::from_millis(jitter(launch::TYPE_GAP_MS.0, launch::TYPE_GAP_MS.1))).await;
        }
        first = false;
        confirm_focus(cdp, selector).await?;
        cdp.insert_text(&chunk).await?;
    }
    Ok(())
}

async fn confirm_focus(cdp: &Cdp, selector: &str) -> Result<(), PortalError> {
    let quoted = js(selector);
    let attrs = cdp
        .evaluate(&format!(
            "(() => {{ const want = document.querySelector({quoted}); const active = document.activeElement; if (!want || active !== want) return null; return {{ type: active.getAttribute('type') || '', autocomplete: active.getAttribute('autocomplete') || '', name: active.getAttribute('name') || '', id: active.id || '', ariaLabel: active.getAttribute('aria-label') || '' }}; }})()"
        ))
        .await?;
    if attrs.is_null() {
        return Err(PortalError::Permanent("focus is not on the checked field".to_string()));
    }
    let field = FieldAttrs {
        type_name: attrs["type"].as_str().unwrap_or("").to_string(),
        autocomplete: attrs["autocomplete"].as_str().unwrap_or("").to_string(),
        name: attrs["name"].as_str().unwrap_or("").to_string(),
        id: attrs["id"].as_str().unwrap_or("").to_string(),
        aria_label: attrs["ariaLabel"].as_str().unwrap_or("").to_string(),
    };
    if guard::refuses_typing(&field) {
        return Err(PortalError::Permanent("focus is not on the checked field".to_string()));
    }
    Ok(())
}

/// True when this page is a challenge or a login page. The reason is recorded and the walk ends.
async fn stopped(cdp: &Cdp, config: &PortalConfig, lines: &mut Vec<String>) -> Result<bool, PortalError> {
    if let Some(reason) = challenge(cdp, config).await? {
        lines.push(format!("stopped: challenge: {reason}"));
        return Ok(true);
    }
    if login_page(cdp, config).await? {
        lines.push("stopped: login page".to_string());
        return Ok(true);
    }
    Ok(false)
}

/// False when navigation itself was refused, so the caller must not open another page.
async fn opened(cdp: &Cdp, config: &PortalConfig, url: &str, lines: &mut Vec<String>) -> Result<bool, PortalError> {
    match open_allowed(cdp, config, url).await {
        Ok(()) => Ok(true),
        Err(error) => {
            lines.push(format!("stopped: {error}"));
            Ok(false)
        }
    }
}

async fn open_allowed(cdp: &Cdp, config: &PortalConfig, url: &str) -> Result<(), PortalError> {
    if !guard::navigation_allowed(url, &config.allowed_origins) {
        return Err(guard::origin_error());
    }
    let current = cdp.current_url().await.unwrap_or_default();
    if same_document(&current, url) {
        cdp.reload().await?;
    } else {
        cdp.navigate(url).await?;
    }
    let landed = cdp.current_url().await?;
    if !landed.starts_with("about:") && !guard::navigation_allowed(&landed, &config.allowed_origins) {
        let origin = guard::origin_of(&landed).unwrap_or(landed);
        return Err(PortalError::Blocked(format!("redirected to {origin}")));
    }
    Ok(())
}

async fn gate(cdp: &Cdp, config: &PortalConfig) -> Result<(), PortalError> {
    if let Some(reason) = challenge(cdp, config).await? {
        return Err(PortalError::Blocked(reason));
    }
    if login_page(cdp, config).await? {
        return Err(PortalError::SignedOut);
    }
    Ok(())
}

async fn challenge(cdp: &Cdp, config: &PortalConfig) -> Result<Option<String>, PortalError> {
    let frames = cdp.evaluate("(() => [...document.querySelectorAll('iframe')].map(frame => frame.src || frame.getAttribute('src') || ''))()").await?;
    let title = cdp.evaluate("document.title").await?;
    let mut selector_hit = false;
    for selector in &config.selectors.captcha {
        if present(cdp, selector).await? {
            selector_hit = true;
            break;
        }
    }
    let srcs: Vec<String> = frames
        .as_array()
        .map(|items| items.iter().filter_map(|value| value.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    Ok(guard::challenge_reason(title.as_str().unwrap_or(""), &srcs, selector_hit))
}

async fn login_page(cdp: &Cdp, config: &PortalConfig) -> Result<bool, PortalError> {
    let url = cdp.current_url().await?;
    if config.paths.login_markers.iter().any(|marker| !marker.is_empty() && url.contains(marker)) {
        return Ok(true);
    }
    present(cdp, &config.selectors.login_form).await
}

async fn session_report(cdp: &Cdp, config: &PortalConfig) -> Result<Vec<String>, PortalError> {
    let mut lines = Vec::new();
    if let Some(reason) = challenge(cdp, config).await? {
        lines.push("signed-in: blocked".to_string());
        lines.push(format!("blocked: {reason}"));
        return Ok(lines);
    }
    lines.push("blocked: no".to_string());
    if login_page(cdp, config).await? {
        lines.push("signed-in: no".to_string());
    } else if present(cdp, &config.selectors.signed_in_marker).await? {
        lines.push("signed-in: yes".to_string());
    } else {
        lines.push("signed-in: no".to_string());
    }
    Ok(lines)
}

async fn probe_group(cdp: &Cdp, group: &str, items: &[(&str, &str)]) -> Result<Vec<String>, PortalError> {
    let mut found = Vec::new();
    let mut missing = Vec::new();
    for (label, selector) in items {
        if selector.is_empty() {
            missing.push((*label).to_string());
            continue;
        }
        if present(cdp, selector).await.unwrap_or(false) {
            found.push((*label).to_string());
        } else {
            missing.push((*label).to_string());
        }
    }
    Ok(vec![format!("{group} selectors found: {}", join_labels(&found)), format!("{group} selectors missing: {}", join_labels(&missing))])
}

fn join_labels(labels: &[String]) -> String {
    if labels.is_empty() {
        "none".to_string()
    } else {
        labels.join(", ")
    }
}

async fn present(cdp: &Cdp, selector: &str) -> Result<bool, PortalError> {
    if selector.is_empty() {
        return Ok(false);
    }
    let value = cdp.evaluate(&format!("!!document.querySelector({})", js(selector))).await?;
    Ok(value.as_bool().unwrap_or(false))
}

async fn wait_for(cdp: &Cdp, selector: &str, timeout: Duration) -> Result<(), PortalError> {
    let deadline = Instant::now() + timeout.min(Duration::from_secs(30));
    loop {
        if present(cdp, selector).await? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(PortalError::Transient(format!("timed out waiting for {selector}")));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn value_of(cdp: &Cdp, selector: &str) -> Result<String, PortalError> {
    let quoted = js(selector);
    let value = cdp.evaluate(&format!("(() => {{ const el = document.querySelector({quoted}); return el ? String(el.value ?? '') : null; }})()")).await?;
    if value.is_null() {
        return Err(PortalError::Transient(format!("field not found: {selector}")));
    }
    Ok(value.as_str().unwrap_or("").trim().to_string())
}

async fn text_of(cdp: &Cdp, selector: &str) -> Result<String, PortalError> {
    let quoted = js(selector);
    let value = cdp.evaluate(&format!("(() => {{ const el = document.querySelector({quoted}); return el ? (el.innerText || el.textContent || '') : ''; }})()")).await?;
    Ok(value.as_str().unwrap_or("").trim().to_string())
}

struct ResultRow {
    sku: String,
    condition: String,
    printing: String,
    language: String,
}

async fn read_results(cdp: &Cdp, config: &PortalConfig) -> Result<Vec<ResultRow>, PortalError> {
    let selectors = &config.selectors;
    let expression = format!(
        "(() => {{ function text(row, selector) {{ const el = row.querySelector(selector); return el ? (el.textContent || '').trim() : ''; }} return [...document.querySelectorAll({})].map(row => ({{ sku: row.getAttribute({}) || '', condition: text(row, {}), printing: text(row, {}), language: text(row, {}) }})); }})()",
        js(&selectors.result_row),
        js(&selectors.row_sku_attribute),
        js(&selectors.condition),
        js(&selectors.printing),
        js(&selectors.language),
    );
    let value = cdp.evaluate(&expression).await?;
    let rows = value.as_array().cloned().unwrap_or_default();
    Ok(rows
        .into_iter()
        .map(|row| ResultRow {
            sku: row["sku"].as_str().unwrap_or("").trim().to_string(),
            condition: row["condition"].as_str().unwrap_or("").trim().to_string(),
            printing: row["printing"].as_str().unwrap_or("").trim().to_string(),
            language: row["language"].as_str().unwrap_or("").trim().to_string(),
        })
        .collect())
}

fn row_matches(row: &ResultRow, target: &ListingTarget) -> bool {
    condition_matches(&row.condition, &target.condition)
        && language_matches(&row.language, &target.language)
        && printing_matches(&row.printing, target.reverse, target.first_edition)
}

struct OrderRow {
    id: String,
    date: String,
    status: String,
    buyer: String,
}

async fn read_order_rows(cdp: &Cdp, config: &PortalConfig) -> Result<Vec<OrderRow>, PortalError> {
    let selectors = &config.selectors;
    let expression = format!(
        "(() => {{ function text(row, selector) {{ const el = row.querySelector(selector); return el ? (el.textContent || '').trim() : ''; }} return [...document.querySelectorAll({})].map(row => ({{ id: text(row, {}), date: text(row, {}), status: text(row, {}), buyer: text(row, {}) }})); }})()",
        js(&selectors.order_row),
        js(&selectors.order_id),
        js(&selectors.order_date),
        js(&selectors.order_status),
        js(&selectors.order_buyer),
    );
    let value = cdp.evaluate(&expression).await?;
    let rows = value.as_array().cloned().unwrap_or_default();
    Ok(rows
        .into_iter()
        .map(|row| OrderRow {
            id: row["id"].as_str().unwrap_or("").trim().to_string(),
            date: row["date"].as_str().unwrap_or("").trim().to_string(),
            status: row["status"].as_str().unwrap_or("").trim().to_string(),
            buyer: row["buyer"].as_str().unwrap_or("").trim().to_string(),
        })
        .filter(|row| !row.id.is_empty())
        .collect())
}

async fn read_order(cdp: &Cdp, config: &PortalConfig, listed: &OrderRow) -> Result<Value, PortalError> {
    let selectors = &config.selectors;
    let placed = text_of(cdp, &selectors.order_date).await?;
    let placed = if placed.is_empty() { listed.date.clone() } else { placed };
    let status = text_of(cdp, &selectors.order_status).await?;
    let status = if status.is_empty() { listed.status.clone() } else { status };
    let buyer = text_of(cdp, &selectors.order_buyer).await?;
    let buyer = if buyer.is_empty() { listed.buyer.clone() } else { buyer };
    let total = text_of(cdp, &selectors.order_total).await?;
    let shipping = text_of(cdp, &selectors.shipping_method).await?;
    let expression = format!(
        "(() => {{ function text(row, selector) {{ const el = row.querySelector(selector); return el ? (el.textContent || '').trim() : ''; }} return [...document.querySelectorAll({})].map(row => ({{ sku: row.getAttribute({}) || '', name: text(row, {}), quantity: text(row, {}), price: text(row, {}) }})); }})()",
        js(&selectors.line_row),
        js(&selectors.line_sku_attribute),
        js(&selectors.line_name),
        js(&selectors.line_quantity),
        js(&selectors.line_price),
    );
    let value = cdp.evaluate(&expression).await?;
    let mut lines = Vec::new();
    for (index, line) in value.as_array().cloned().unwrap_or_default().into_iter().enumerate() {
        let sku = line["sku"].as_str().unwrap_or("").trim().to_string();
        let name = line["name"].as_str().unwrap_or("").trim().to_string();
        let quantity = line["quantity"].as_str().unwrap_or("").trim().parse::<i64>().unwrap_or(0);
        let price = parse_money(line["price"].as_str().unwrap_or("")).unwrap_or(0);
        lines.push(json!({
            "lineKey": format!("{}-{}-{}", listed.id, sku, index),
            "externalId": sku,
            "name": name,
            "quantity": quantity,
            "priceCents": price,
        }));
    }
    Ok(json!({
        "externalOrderId": listed.id,
        "status": status,
        "placedAt": normalize_time(&placed),
        "buyerName": buyer,
        "shipTo": {
            "name": text_of(cdp, &selectors.ship_name).await?,
            "line1": text_of(cdp, &selectors.ship_line1).await?,
            "line2": text_of(cdp, &selectors.ship_line2).await?,
            "city": text_of(cdp, &selectors.ship_city).await?,
            "state": text_of(cdp, &selectors.ship_state).await?,
            "zip": text_of(cdp, &selectors.ship_zip).await?,
            "country": text_of(cdp, &selectors.ship_country).await?,
        },
        "shippingMethod": shipping,
        "totalCents": parse_money(&total).unwrap_or(0),
        "currency": "USD",
        "lines": lines,
    }))
}

async fn next_href(cdp: &Cdp, selector: &str) -> Result<Option<String>, PortalError> {
    let quoted = js(selector);
    let value = cdp.evaluate(&format!("(() => {{ const el = document.querySelector({quoted}); return el ? (el.href || '') : ''; }})()")).await?;
    let href = value.as_str().unwrap_or("").trim().to_string();
    if href.is_empty() {
        Ok(None)
    } else {
        Ok(Some(href))
    }
}

fn require_sku(external_id: &str) -> Result<&str, PortalError> {
    let sku = external_id.trim();
    if sku.is_empty() {
        Err(PortalError::Permanent("missing TCGplayer SKU".to_string()))
    } else {
        Ok(sku)
    }
}

fn require_qty(quantity: i64) -> Result<(), PortalError> {
    if quantity < 0 {
        Err(PortalError::Permanent("quantity must be zero or more".to_string()))
    } else {
        Ok(())
    }
}

fn search_query(target: &ListingTarget) -> String {
    let set_name = target.set_name.trim();
    let collector = target.collector_number.trim();
    if !set_name.is_empty() && !collector.is_empty() {
        format!("{set_name} {collector}")
    } else {
        target.card_name.trim().to_string()
    }
}

fn condition_matches(cell: &str, code: &str) -> bool {
    let Some(label) = condition_label(code) else {
        return false;
    };
    cell.trim().eq_ignore_ascii_case(label)
}

fn condition_label(code: &str) -> Option<&'static str> {
    match code.trim().to_ascii_uppercase().as_str() {
        "NM" | "NEAR MINT" => Some("Near Mint"),
        "LP" | "LIGHTLY PLAYED" => Some("Lightly Played"),
        "MP" | "MODERATELY PLAYED" => Some("Moderately Played"),
        "HP" | "HEAVILY PLAYED" => Some("Heavily Played"),
        "DMG" | "DAMAGED" => Some("Damaged"),
        _ => None,
    }
}

fn language_matches(cell: &str, code: &str) -> bool {
    let cell = cell.trim();
    if cell.is_empty() || code.trim().is_empty() {
        return false;
    }
    if let Some(label) = language_label(code) {
        return cell.eq_ignore_ascii_case(label);
    }
    cell.eq_ignore_ascii_case(code.trim())
}

fn language_label(code: &str) -> Option<&'static str> {
    match code.trim().to_ascii_uppercase().as_str() {
        "EN" | "ENGLISH" => Some("English"),
        "JP" | "JA" | "JAPANESE" => Some("Japanese"),
        "KO" | "KR" | "KOREAN" => Some("Korean"),
        "ZH" | "CN" | "ZHS" | "CHINESE" => Some("Chinese"),
        "ZHT" => Some("Chinese (Traditional)"),
        "FR" | "FRENCH" => Some("French"),
        "DE" | "GERMAN" => Some("German"),
        "ES" | "SPANISH" => Some("Spanish"),
        "IT" | "ITALIAN" => Some("Italian"),
        "PT" | "PORTUGUESE" => Some("Portuguese"),
        _ => None,
    }
}

fn printing_matches(cell: &str, reverse: bool, first_edition: bool) -> bool {
    let cell = cell.to_ascii_lowercase();
    let is_reverse = cell.contains("reverse");
    let is_first = cell.contains("1st") || cell.contains("first");
    is_reverse == reverse && is_first == first_edition
}

/// `$1,234.56` → 123456. Digits only; no floating point.
pub fn parse_money(text: &str) -> Option<i64> {
    let negative = text.trim().starts_with('-');
    let mut whole = String::new();
    let mut frac = String::new();
    let mut seen_dot = false;
    let mut any = false;
    for ch in text.chars() {
        if ch == '.' {
            if seen_dot {
                break;
            }
            seen_dot = true;
            continue;
        }
        if ch.is_ascii_digit() {
            any = true;
            if seen_dot {
                if frac.len() < 2 {
                    frac.push(ch);
                }
            } else {
                whole.push(ch);
            }
        }
    }
    if !any {
        return None;
    }
    if whole.is_empty() {
        whole.push('0');
    }
    while frac.len() < 2 {
        frac.push('0');
    }
    let dollars: i64 = whole.parse().ok()?;
    let cents: i64 = frac.parse().ok()?;
    let mut value = dollars.checked_mul(100)?.checked_add(cents)?;
    if negative {
        value = -value;
    }
    Some(value)
}

fn format_dollars(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let cents = cents.unsigned_abs();
    format!("{sign}{}.{:02}", cents / 100, cents % 100)
}

fn same_qty(current: &str, want: i64) -> bool {
    let digits: String = current.trim().chars().take_while(|ch| ch.is_ascii_digit() || *ch == '-').collect();
    digits.parse::<i64>().ok() == Some(want)
}

fn same_document(current: &str, next: &str) -> bool {
    fn norm(value: &str) -> String {
        value.trim().trim_end_matches('/').to_string()
    }
    !current.is_empty() && !current.starts_with("about:") && norm(current) == norm(next)
}

fn cutoff_unix(since: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(since).ok().map(|time| time.timestamp() - 86_400)
}

fn row_unix(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text.trim()).ok().map(|time| time.timestamp())
}

fn normalize_time(text: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(text.trim()) {
        Ok(time) => time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        Err(_) => text.trim().to_string(),
    }
}

fn chunks(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut index = 0;
    let mut step = 0;
    while index < chars.len() {
        let size = 1 + (step % 3);
        let end = (index + size).min(chars.len());
        out.push(chars[index..end].iter().collect());
        index = end;
        step += 1;
    }
    out
}

fn js(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

async fn pace(options: &LaunchOptions) {
    let millis = jitter(options.action_gap_ms.0, options.action_gap_ms.1);
    if millis > 0 {
        tokio::time::sleep(Duration::from_millis(millis)).await;
    }
}

fn jitter(min: u64, max: u64) -> u64 {
    if max <= min {
        return min;
    }
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.subsec_nanos()).unwrap_or(0);
    min + u64::from(nanos) % (max - min + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn money_parses_grouped_dollars_without_floats() {
        assert_eq!(parse_money("$1,234.56"), Some(123_456));
        assert_eq!(parse_money("$1.50"), Some(150));
        assert_eq!(parse_money("$10"), Some(1_000));
        assert_eq!(format_dollars(38369), "383.69");
    }

    #[test]
    fn listing_match_uses_condition_printing_and_language() {
        let row = ResultRow {
            sku: "NM-EN".into(),
            condition: "Near Mint".into(),
            printing: "Normal".into(),
            language: "English".into(),
        };
        let mut target = ListingTarget { condition: "NM".into(), language: "EN".into(), ..ListingTarget::default() };
        assert!(row_matches(&row, &target));
        target.language = "JP".into();
        assert!(!row_matches(&row, &target));
        target.language = "EN".into();
        target.reverse = true;
        assert!(!row_matches(&row, &target));
        assert!(printing_matches("Reverse Holofoil", true, false));
        assert!(printing_matches("1st Edition", false, true));
        assert!(condition_matches("Lightly Played", "LP"));
        assert!(language_matches("Japanese", "JP"));
    }

    #[test]
    fn search_uses_the_set_and_collector_number() {
        let target = ListingTarget {
            set_name: "Jungle".into(),
            collector_number: "51/64".into(),
            card_name: "Eevee".into(),
            ..ListingTarget::default()
        };
        assert_eq!(search_query(&target), "Jungle 51/64");
        let named = ListingTarget { card_name: "Eevee".into(), ..ListingTarget::default() };
        assert_eq!(search_query(&named), "Eevee");
    }
}
