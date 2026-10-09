use super::{accounts_firestore, clipped, now_ms, read_pool, text, writer_pool, Options};
use anyhow::{bail, Context, Result};
use pokoin_accounts::firestore::{DocData, FilterOp, Firestore, Query, Value as FireValue};
use pokoin_commerce::{
    config::CommerceConfig, firestore::FirestoreClient, handlers::orders, state::DomainState,
};
use serde_json::{json, Value};
use std::sync::Arc;

const STALE_MS: i64 = 35 * 60 * 1000;
fn millis(value: Option<&Value>) -> i64 {
    pokoin_accounts::domain::portfolio_history::coerce_date_millis(value).unwrap_or(0)
}
fn stale(order: &Value, now: i64) -> bool {
    let ends = millis(order.pointer("/inventory/expiresAt"));
    let created = millis(order.get("createdAt"));
    (ends != 0 && now > ends) || (created != 0 && now - created > STALE_MS)
}
fn paid(session: &Value) -> bool {
    session["status"] == "complete" && session["payment_status"] != "unpaid"
}
fn action(order: &Value, session: Option<&Value>, now: i64) -> &'static str {
    let Some(session) = session else {
        return "release_no_session";
    };
    if paid(session) {
        "recover_paid"
    } else if session["status"] == "complete" {
        "processing"
    } else if session["status"] == "open"
        && now
            < session
                .get("expires_at")
                .and_then(Value::as_f64)
                .unwrap_or(0.0) as i64
                * 1000
        && order.pointer("/inventory/state") == Some(&json!("reserved"))
    {
        "still_open"
    } else {
        "release_expired"
    }
}
#[derive(Debug, PartialEq)]
enum PaidPlan {
    Ignore,
    Processing,
    Duplicate,
    New(Value),
}
fn number(value: Option<&Value>) -> Option<f64> {
    match value {
        None => None,
        Some(Value::Null) => Some(0.0),
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => {
            if s.trim().is_empty() {
                Some(0.0)
            } else {
                s.trim().parse().ok()
            }
        }
        _ => None,
    }
}
fn paid_plan(order: &Value, session: &Value, at: &str) -> Result<PaidPlan> {
    let id = text(session.pointer("/metadata/pokoinOrderId"))
        .trim()
        .to_string();
    if session.pointer("/metadata/kind") != Some(&json!("marketplace_order_eur")) || id.is_empty() {
        return Ok(PaidPlan::Ignore);
    }
    if session["payment_status"] == "unpaid" {
        return Ok(if order["paymentStatus"] == "pending_stripe" {
            PaidPlan::Processing
        } else {
            PaidPlan::Ignore
        });
    }
    let status = text(order.get("paymentStatus"));
    if matches!(
        status.as_str(),
        "paid" | "escrow" | "released" | "partially_refunded"
    ) || (session.get("id").is_some() && order.get("stripePaidSessionId") == session.get("id"))
    {
        return Ok(PaidPlan::Duplicate);
    }
    let discount = number(order.pointer("/pknDiscount/eurCents")).unwrap_or(0.0);
    if let (Some(total), Some(amount)) = (
        number(order.get("totalEURCents")),
        number(session.get("amount_total")),
    ) {
        let expected = total - discount;
        if expected.is_finite() && amount.is_finite() && expected != amount {
            bail!("Stripe amount {amount} does not match order {expected}.");
        }
    }
    let uid = text(session.pointer("/metadata/pokoinUid"))
        .trim()
        .to_string();
    let buyer = text(order.get("buyerUid"));
    if !uid.is_empty() && !buyer.is_empty() && uid != buyer {
        bail!("Stripe session uid does not match order buyer.");
    }
    let intent = session
        .get("payment_intent")
        .map(|pi| {
            if pi.is_string() {
                text(Some(pi))
            } else {
                text(pi.get("id"))
            }
        })
        .unwrap_or_default();
    let mut patch = json!({"paymentStatus":"paid","status":"paid","paidAt":at,"updatedAt":at,"stripePaidSessionId":session.get("id").cloned().unwrap_or(Value::Null),"stripePaymentIntentId":intent});
    if order.pointer("/pknDiscount/state") == Some(&json!("held")) {
        patch["pknDiscount"] = order["pknDiscount"].clone();
        patch["pknDiscount"]["state"] = json!("consumed");
        patch["pknDiscount"]["consumedAt"] = json!(at);
    }
    Ok(PaidPlan::New(patch))
}
trait Backend {
    async fn pending(&mut self) -> Result<Vec<(String, Value)>>;
    async fn unfinished(&mut self) -> Result<Vec<(String, Value)>>;
    async fn session(&mut self, id: &str) -> Result<Value>;
    async fn expire(&mut self, id: &str) -> Result<()>;
    async fn release(&mut self, id: &str, reason: &str) -> Result<Value>;
    async fn on_paid(&mut self, session: &Value) -> Result<Value>;
    async fn fulfill(&mut self, id: &str) -> Result<Value>;
}
async fn sweep(backend: &mut impl Backend, now: i64, dry_run: bool) -> Result<Value> {
    let mut results = Vec::new();
    for (order_id, order) in backend.pending().await? {
        if !stale(&order, now) {
            continue;
        }
        let mut row = json!({"orderId":order_id,"action":"none"});
        let outcome = async {
            let session_id = clipped(text(order.get("stripeCheckoutSessionId")).trim(), 200);
            let session = if session_id.is_empty() {
                None
            } else {
                Some(backend.session(&session_id).await?)
            };
            let selected = action(&order, session.as_ref(), now);
            row["action"] = json!(selected);
            if !dry_run {
                match selected {
                    "release_no_session" => {
                        backend.release(&order_id, "session_missing").await?;
                    }
                    "recover_paid" => {
                        backend
                            .on_paid(session.as_ref().context("missing paid session")?)
                            .await?;
                    }
                    "release_expired" => {
                        if session.as_ref().is_some_and(|s| s["status"] == "open") {
                            backend.expire(&session_id).await?;
                        }
                        backend.release(&order_id, "expired").await?;
                    }
                    _ => {}
                }
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = outcome {
            row["action"] = json!("error");
            row["error"] = json!(clipped(&error.to_string(), 300));
        }
        println!("eur order sweep {row}");
        results.push(row);
    }
    for (order_id, _) in backend.unfinished().await? {
        let mut row = json!({"orderId":order_id,"action":"resume_fulfillment"});
        if !dry_run {
            match backend.fulfill(&order_id).await {
                Ok(result) => {
                    if let Some(fields) = result.as_object() {
                        for (key, value) in fields {
                            row[key] = value.clone();
                        }
                    }
                }
                Err(error) => row["error"] = json!(error.to_string()),
            }
        }
        println!("eur order sweep {row}");
        results.push(row);
    }
    let ok = results
        .iter()
        .all(|r| r["action"] != "error" && r.get("error").is_none_or(|e| e.is_null() || e == ""));
    Ok(json!({"ok":ok,"results":results}))
}
struct Native {
    state: DomainState,
    firestore: Firestore,
}
impl Backend for Native {
    async fn pending(&mut self) -> Result<Vec<(String, Value)>> {
        Ok(self
            .firestore
            .run_query(&Query::collection("orders").where_eq("paymentStatus", "pending_stripe"))
            .await?
            .iter()
            .map(|d| (d.id(), d.to_plain_json()))
            .collect())
    }
    async fn unfinished(&mut self) -> Result<Vec<(String, Value)>> {
        let query = Query::collection("orders").where_op(
            "fulfillment.state",
            FilterOp::In,
            FireValue::from_plain_json(&json!(["running", "partial"])),
        );
        Ok(self
            .firestore
            .run_query(&query)
            .await?
            .iter()
            .map(|d| (d.id(), d.to_plain_json()))
            .collect())
    }
    async fn session(&mut self, id: &str) -> Result<Value> {
        let session = self.state.stripe()?.retrieve_checkout_session(id).await?;
        if let Some(error) = session.get("error") {
            bail!("{}", text(error.get("message")));
        }
        Ok(session)
    }
    async fn expire(&mut self, id: &str) -> Result<()> {
        let id = percent_encoding::utf8_percent_encode(id, percent_encoding::NON_ALPHANUMERIC);
        let mut request = self
            .state
            .http()
            .post(format!(
                "https://api.stripe.com/v1/checkout/sessions/{id}/expire"
            ))
            .bearer_auth(
                self.state
                    .config()
                    .stripe_secret_key
                    .as_deref()
                    .context("STRIPE_SECRET_KEY is not configured.")?,
            )
            .form(&Vec::<(String, String)>::new());
        if let Some(version) = &self.state.config().stripe_api_version {
            request = request.header("Stripe-Version", version);
        }
        let response = request.send().await?;
        let status = response.status();
        let body: Value = response.json().await?;
        if !status.is_success() {
            bail!("{}", text(body.pointer("/error/message")));
        }
        Ok(())
    }
    async fn release(&mut self, id: &str, reason: &str) -> Result<Value> {
        Ok(orders::release_eur_reservation(&self.state, id, reason, "expired", &[]).await?)
    }
    async fn on_paid(&mut self, session: &Value) -> Result<Value> {
        let id = text(session.pointer("/metadata/pokoinOrderId"))
            .trim()
            .to_string();
        let session = session.clone();
        let at = pokoin_external::time_util::iso_from_ms(now_ms());
        let plan = self
            .firestore
            .run_transaction(|tx| {
                let id = id.clone();
                let session = session.clone();
                let at = at.clone();
                Box::pin(async move {
                    let reference = tx.collection("orders").doc(&id);
                    let doc = tx.get_doc(&reference).await?.ok_or_else(|| {
                        pokoin_accounts::error::ApiError::new(
                            axum::http::StatusCode::NOT_FOUND,
                            format!("Order {id} not found for Stripe session."),
                        )
                    })?;
                    let plan = paid_plan(&doc.to_plain_json(), &session, &at).map_err(|e| {
                        pokoin_accounts::error::ApiError::new(
                            axum::http::StatusCode::CONFLICT,
                            e.to_string(),
                        )
                    })?;
                    match &plan {
                        PaidPlan::New(patch) => {
                            let mut data = DocData::from_json(patch)
                                .server_timestamp("paidAt")
                                .server_timestamp("updatedAt");
                            if patch.get("pknDiscount").is_some() {
                                data = data.server_timestamp("pknDiscount.consumedAt");
                            }
                            tx.set(&reference, data, true)?;
                        }
                        PaidPlan::Processing => {
                            tx.set(
                                &reference,
                                DocData::new()
                                    .string("paymentStatus", "processing")
                                    .server_timestamp("updatedAt"),
                                true,
                            )?;
                        }
                        _ => {}
                    }
                    Ok(plan)
                })
            })
            .await?;
        match plan {
            PaidPlan::Ignore => Ok(Value::Null),
            PaidPlan::Processing => Ok(json!({"orderId":id,"processing":true})),
            PaidPlan::Duplicate | PaidPlan::New(_) => {
                let intent = session
                    .get("payment_intent")
                    .map(|v| {
                        if v.is_string() {
                            text(Some(v))
                        } else {
                            text(v.get("id"))
                        }
                    })
                    .unwrap_or_default();
                if !intent.is_empty() {
                    if let Ok(charge) = self
                        .state
                        .stripe()?
                        .retrieve_payment_intent_charge(&intent)
                        .await
                    {
                        if !charge.is_empty() {
                            self.firestore
                                .collection_doc("orders", &id)
                                .set(DocData::new().string("stripeChargeId", charge), true)
                                .await?;
                        }
                    }
                }
                let result = orders::fulfil_paid_eur_order(&self.state, &id).await?;
                Ok(json!({"orderId":id,"fulfillment":result}))
            }
        }
    }
    async fn fulfill(&mut self, id: &str) -> Result<Value> {
        Ok(orders::fulfil_paid_eur_order(&self.state, id).await?)
    }
}
pub(super) async fn run(options: &Options) -> Result<()> {
    let config = CommerceConfig::from_env();
    if config
        .stripe_secret_key
        .as_ref()
        .is_none_or(|s| s.is_empty())
    {
        bail!("STRIPE_SECRET_KEY is not configured.");
    }
    let firestore = accounts_firestore()?;
    let read = read_pool().await?;
    let write = writer_pool(&read).await?;
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let native_firestore = FirestoreClient::from_env(http.clone())?;
    let verifier = Arc::new(pokoin_commerce::auth::FirebaseVerifier::new(
        std::env::var("FIREBASE_PROJECT_ID").unwrap_or_default(),
        http,
    ));
    let adapter = pokoin_commerce::cardtrader_adapter::NativeCardTrader::from_env()?;
    let state =
        DomainState::with_pools(config, read, write, None, verifier, Some(native_firestore))
            .with_cardtrader(Arc::new(adapter));
    let report = sweep(&mut Native { state, firestore }, now_ms(), options.dry_run).await?;
    println!("eur order sweep complete {report}");
    if report["ok"] != true {
        bail!("EUR order sweep failed.");
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Mock {
        sessions: std::collections::HashMap<String, Value>,
        calls: Vec<String>,
        fail: bool,
    }
    impl Backend for Mock {
        async fn pending(&mut self) -> Result<Vec<(String, Value)>> {
            Ok(vec![
                ("ghost".into(), json!({"createdAt":{"seconds":1}})),
                (
                    "paid".into(),
                    json!({"createdAt":{"seconds":1},"stripeCheckoutSessionId":"paid"}),
                ),
                (
                    "open".into(),
                    json!({"createdAt":{"seconds":1},"stripeCheckoutSessionId":"open"}),
                ),
            ])
        }
        async fn unfinished(&mut self) -> Result<Vec<(String, Value)>> {
            Ok(vec![("partial".into(), json!({}))])
        }
        async fn session(&mut self, id: &str) -> Result<Value> {
            self.sessions.get(id).cloned().context("Stripe unavailable")
        }
        async fn expire(&mut self, id: &str) -> Result<()> {
            self.calls.push(format!("expire:{id}"));
            if self.fail {
                bail!("Stripe expire failed");
            }
            Ok(())
        }
        async fn release(&mut self, id: &str, _: &str) -> Result<Value> {
            self.calls.push(format!("release:{id}"));
            Ok(json!({"outcome":"released"}))
        }
        async fn on_paid(&mut self, _: &Value) -> Result<Value> {
            self.calls.push("paid".into());
            Ok(json!({}))
        }
        async fn fulfill(&mut self, _: &str) -> Result<Value> {
            self.calls.push("fulfill".into());
            Ok(json!({"done":true}))
        }
    }
    fn mock() -> Mock {
        Mock {
            sessions: std::collections::HashMap::from([
                (
                    "paid".into(),
                    json!({"status":"complete","payment_status":"paid"}),
                ),
                ("open".into(), json!({"status":"open","expires_at":999999})),
            ]),
            ..Default::default()
        }
    }
    #[test]
    fn stale_and_session_actions_cover_reference_branches() {
        assert!(!stale(&json!({}), 3_000_000));
        assert!(!stale(&json!({"createdAt":{"seconds":1}}), STALE_MS + 1000));
        assert!(stale(&json!({"inventory":{"expiresAt":1}}), 2));
        assert_eq!(
            action(
                &json!({}),
                Some(&json!({"status":"complete","payment_status":"unpaid"})),
                0
            ),
            "processing"
        );
        assert_eq!(
            action(
                &json!({"inventory":{"state":"reserved"}}),
                Some(&json!({"status":"open","expires_at":10})),
                1
            ),
            "still_open"
        );
        assert_eq!(
            action(
                &json!({}),
                Some(&json!({"status":"open","expires_at":10})),
                1
            ),
            "release_expired"
        );
    }
    #[test]
    fn paid_plan_accounts_for_discount_uid_and_duplicate() {
        let session = json!({"id":"cs_1","payment_status":"paid","amount_total":800,"metadata":{"kind":"marketplace_order_eur","pokoinOrderId":"o","pokoinUid":"u"}});
        let order = json!({"buyerUid":"u","totalEURCents":1000,"pknDiscount":{"eurCents":200,"state":"held","pkn":40}});
        let PaidPlan::New(patch) = paid_plan(&order, &session, "at").unwrap() else {
            panic!("new")
        };
        assert_eq!(patch["pknDiscount"]["state"], "consumed");
        assert_eq!(patch["pknDiscount"]["eurCents"], 200);
        assert_eq!(
            paid_plan(&json!({"paymentStatus":"escrow"}), &session, "at").unwrap(),
            PaidPlan::Duplicate
        );
        assert!(paid_plan(
            &json!({"buyerUid":"wrong","totalEURCents":800}),
            &session,
            "at"
        )
        .is_err());
        assert!(paid_plan(&json!({"totalEURCents":900}), &session, "at").is_err());
    }
    #[tokio::test]
    async fn dry_run_has_no_writes_and_expire_precedes_release() {
        let mut backend = mock();
        assert_eq!(
            sweep(&mut backend, 3_000_000, true).await.unwrap()["ok"],
            true
        );
        assert!(backend.calls.is_empty());
        let report = sweep(&mut backend, 3_000_000, false).await.unwrap();
        assert_eq!(report["ok"], true);
        assert_eq!(
            backend.calls,
            [
                "release:ghost",
                "paid",
                "expire:open",
                "release:open",
                "fulfill"
            ]
        );
    }
    #[tokio::test]
    async fn expiry_failure_never_releases_stock() {
        let mut backend = mock();
        backend.fail = true;
        assert_eq!(
            sweep(&mut backend, 3_000_000, false).await.unwrap()["ok"],
            false
        );
        assert!(!backend.calls.iter().any(|s| s == "release:open"));
        assert!(backend.calls.iter().any(|s| s == "fulfill"));
    }
}
