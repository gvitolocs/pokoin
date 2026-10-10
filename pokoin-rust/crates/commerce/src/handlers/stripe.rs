//! Stripe: PKN checkout sessions, the marketplace webhook and Connect
//! Express onboarding.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use super::{private_json, text_field};
use crate::domain::money;
use crate::error::ApiError;
use crate::state::{AuthedUser, DomainState};
use crate::store::{self, LedgerOp};

/// Allowed PKN packages: fiat cents → Stripe lookup key.
fn package_lookup_key(fiat_cents: i64) -> Option<&'static str> {
    match fiat_cents {
        500 => Some("pkn_starter_1000_pkn_500_eur"),
        2500 => Some("pkn_collector_5000_pkn_2500_eur"),
        10000 => Some("pkn_validator_20000_pkn_10000_eur"),
        _ => None,
    }
}

/// `handleCompletedCheckout` from `_pkn_purchase.js`, on native SQL.
pub async fn handle_completed_checkout(
    state: &DomainState,
    session: &Value,
) -> Result<Value, ApiError> {
    let session_id = session
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if session_id.is_empty() {
        return Err(ApiError::bad_request("Invalid checkout metadata."));
    }
    let metadata = session.get("metadata").cloned().unwrap_or(json!({}));
    let uid = metadata.get("uid").and_then(Value::as_str).unwrap_or_default();
    let pkn_amount = metadata
        .get("pknAmount")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<i64>().ok())
        .or_else(|| metadata.get("pknAmount").and_then(Value::as_i64))
        .unwrap_or(0);
    if uid.is_empty() || pkn_amount <= 0 {
        return Err(ApiError::bad_request("Invalid checkout metadata."));
    }
    let fiat_cents = metadata
        .get("fiatCents")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<i64>().ok())
        .or_else(|| session.get("amount_total").and_then(Value::as_i64))
        .unwrap_or(0);

    let key = format!("stripe_pkn_purchase:{session_id}");
    let op = LedgerOp::mint(uid, pkn_amount, "pkn_purchase_credit")
        .with_idempotency(key.clone())
        .with_ref(&session_id)
        .with_meta(json!({
            "stripeSessionId": session_id,
            "stripePaymentIntentId": session.get("payment_intent").cloned().unwrap_or(Value::Null),
            "amountFiat": fiat_cents,
            "currency": session.get("currency").cloned().unwrap_or(json!("eur")),
            "fulfillmentTarget": "site_credit",
        }));
    let outcome = store::apply(state.firestore()?, &op).await?;
    let firestore = state.firestore()?;
    let purchase = json!({
        "uid": uid,
        "email": metadata.get("email").and_then(Value::as_str).unwrap_or_default(),
        "stripeSessionId": session_id,
        "stripePaymentIntentId": session.get("payment_intent").cloned().unwrap_or(Value::Null),
        "amountFiat": fiat_cents,
        "currency": session.get("currency").cloned().unwrap_or(json!("eur")),
        "amountPkn": pkn_amount,
        "fulfillmentTarget": "site_credit",
        "status": "credited",
        "createdAt": store::now_iso(),
        "paidAt": store::now_iso(),
    });
    let _ = firestore
        .set_document(
            &firestore.document_path(store::PKN_PURCHASES, &session_id),
            &purchase,
        )
        .await;

    Ok(json!({
        "amountPkn": pkn_amount,
        "fulfillmentTarget": "site_credit",
        "status": "credited",
        "credited": outcome.applied,
    }))
}

/// `POST /api/create-pkn-checkout-session`.
pub async fn create_pkn_checkout_session(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let stripe = state.stripe()?;

    if let Some(session_id) = body
        .get("checkoutSessionId")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        let session = stripe.retrieve_checkout_session(&session_id).await?;
        let owner = session
            .get("metadata")
            .and_then(|metadata| metadata.get("uid"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if owner != claims.uid {
            return Err(ApiError::forbidden(
                "Checkout session does not belong to this account.",
            ));
        }
        if session.get("payment_status").and_then(Value::as_str) != Some("paid") {
            return Err(ApiError::conflict("Payment is not complete yet."));
        }
        let result = handle_completed_checkout(&state, &session).await?;
        let mut payload = json!({ "ok": true });
        if let (Some(object), Some(extra)) = (payload.as_object_mut(), result.as_object()) {
            for (key, value) in extra {
                object.insert(key.clone(), value.clone());
            }
        }
        return Ok(private_json(payload));
    }

    let reference = state
        .config()
        .pkn_checkout_reference_price()
        .map_err(ApiError::internal)?;
    let fiat_cents = body.get("fiatCents").and_then(Value::as_i64).unwrap_or(0);
    let expected_pkn = money::pkn_amount_for_fiat_cents(fiat_cents, reference);
    let requested_pkn = body
        .get("pknAmount")
        .and_then(Value::as_f64)
        .map(|value| value.trunc() as i64)
        .unwrap_or(0);
    if package_lookup_key(fiat_cents).is_none() || requested_pkn != expected_pkn {
        return Err(ApiError::bad_request("Invalid PKN package."));
    }
    let lookup_key = text_field(&body, &["lookupKey"], 80);
    let price_id = if lookup_key.is_empty() {
        None
    } else if package_lookup_key(fiat_cents) == Some(lookup_key.as_str()) {
        stripe.list_prices(&lookup_key, fiat_cents).await?
    } else {
        None
    };

    let email = claims.email.clone();
    let site = state.config().public_site_url.trim_end_matches('/').to_string();
    let currency = state.config().pkn_checkout_currency.clone();
    let mut form: Vec<(String, String)> = vec![
        ("mode".into(), "payment".into()),
        ("payment_method_types[0]".into(), "card".into()),
        ("success_url".into(), format!("{site}/buy?status=success&session_id={{CHECKOUT_SESSION_ID}}")),
        ("cancel_url".into(), format!("{site}/buy?status=cancelled")),
        ("line_items[0][quantity]".into(), "1".into()),
        ("metadata[uid]".into(), claims.uid.clone()),
        ("metadata[email]".into(), email.clone()),
        ("metadata[pknAmount]".into(), expected_pkn.to_string()),
        ("metadata[fiatCents]".into(), fiat_cents.to_string()),
        ("metadata[lookupKey]".into(), lookup_key.clone()),
        ("metadata[fulfillmentTarget]".into(), "site_credit".into()),
    ];
    if !email.is_empty() {
        form.push(("customer_email".into(), email));
    }
    match price_id {
        Some(price_id) => form.push(("line_items[0][price]".into(), price_id)),
        None => {
            form.push((
                "line_items[0][price_data][currency]".into(),
                currency,
            ));
            form.push((
                "line_items[0][price_data][unit_amount]".into(),
                fiat_cents.to_string(),
            ));
            form.push((
                "line_items[0][price_data][product_data][name]".into(),
                format!("{expected_pkn} PKN"),
            ));
            form.push((
                "line_items[0][price_data][product_data][description]".into(),
                format!(
                    "Pokoin account balance credit at 1 PKN = {reference} USDT."
                ),
            ));
        }
    }

    let session = stripe.create_checkout_session(form).await?;
    Ok(private_json(json!({
        "id": session.get("id").cloned().unwrap_or(Value::Null),
        "url": session.get("url").cloned().unwrap_or(Value::Null),
    })))
}

// ---------------------------------------------------------------------------
// /api/stripe-webhook
// ---------------------------------------------------------------------------

pub async fn stripe_webhook(state: State<DomainState>, headers: HeaderMap, body: Bytes) -> Response {
    match stripe_webhook_inner(state, headers, body).await {
        Ok(response) => response,
        Err(error) => {
            let signature_error = error.status == StatusCode::BAD_REQUEST && error.message.starts_with("Webhook Error:");
            let configuration_error = error.message == "Stripe webhook is not configured.";
            let (status, message) = if signature_error { (StatusCode::BAD_REQUEST, error.message) }
                else if configuration_error { (StatusCode::INTERNAL_SERVER_ERROR, error.message) }
                else { tracing::error!(%error, "Stripe webhook handling failed"); (StatusCode::INTERNAL_SERVER_ERROR, "Webhook handling failed.".to_string()) };
            stripe_text(status, &message)
        }
    }
}
fn stripe_text(status: StatusCode, message: &str) -> Response {
    (status, [("content-type", "text/plain; charset=utf-8")], message.to_string()).into_response()
}
pub async fn stripe_webhook_method_not_allowed() -> Response {
    let mut response = stripe_text(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    response.headers_mut().insert("allow", axum::http::HeaderValue::from_static("POST"));
    response
}

async fn stripe_webhook_inner(
    State(state): State<DomainState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let stripe = state.stripe().map_err(|_| ApiError::internal("Stripe webhook is not configured."))?;
    let signature = headers
        .get("stripe-signature")
        .and_then(|value| value.to_str().ok());
    // Stripe's constructEvent default tolerance.
    stripe.verify_webhook(&body, signature, 300)?;

    let event: Value = serde_json::from_slice(&body)
        .map_err(|_| ApiError::bad_request("Webhook Error: invalid JSON payload."))?;
    let event_id = event.get("id").and_then(Value::as_str).unwrap_or_default();
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or_default();

    // Idempotency: Stripe retries the same event id.
    if !event_id.is_empty() {
        let claimed = store::claim_idempotency(
            state.firestore()?,
            &format!("stripe_event:{event_id}"),
            None,
            &json!({ "type": event_type }),
        )
        .await?;
        if !claimed {
            return Ok(Json(json!({ "received": true, "duplicate": true })).into_response());
        }
    }

    if event_type == "checkout.session.completed" || event_type == "checkout.session.async_payment_succeeded" {
        let session = event
            .get("data")
            .and_then(|data| data.get("object"))
            .cloned()
            .unwrap_or(json!({}));
        let kind = session
            .get("metadata")
            .and_then(|metadata| metadata.get("kind"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if kind == "marketplace_order_eur" {
            let order_id = session
                .get("metadata")
                .and_then(|metadata| metadata.get("pokoinOrderId"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if order_id.is_empty() {
                return Err(ApiError::bad_request("Order id missing from the Stripe session."));
            }
            handle_marketplace_order_paid(&state, &order_id, &session).await?;
        } else {
            handle_completed_checkout(&state, &session).await?;
        }
    } else if event_type == "checkout.session.expired" || event_type == "checkout.session.async_payment_failed" {
        let session = event
            .get("data")
            .and_then(|data| data.get("object"))
            .cloned()
            .unwrap_or(json!({}));
        if session
            .get("metadata")
            .and_then(|metadata| metadata.get("kind"))
            .and_then(Value::as_str)
            == Some("marketplace_order_eur")
        {
            let order_id = session
                .get("metadata")
                .and_then(|metadata| metadata.get("pokoinOrderId"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if !order_id.is_empty() {
                // Node: `expired` releases from the plain set; a failed async
                // payment may also release an order Stripe left `processing`.
                let failed = event_type.ends_with("failed");
                let (reason, status, extra): (&str, &str, &[&str]) = if failed {
                    ("payment_failed", "failed", &["processing"])
                } else {
                    ("expired", "expired", &[])
                };
                let _ = super::orders::release_eur_reservation(
                    &state, &order_id, reason, status, extra,
                )
                .await?;
            }
        }
    }

    Ok(Json(json!({ "received": true })).into_response())
}

/// Mark a EUR order paid, consume the PKN discount and commit the stock hold.
pub(crate) async fn handle_marketplace_order_paid(
    state: &DomainState,
    order_id: &str,
    session: &Value,
) -> Result<(), ApiError> {
    let firestore = state.firestore()?;
    let order = firestore
        .get_document(&firestore.document_path(store::ORDERS, order_id))
        .await?
        .ok_or_else(|| ApiError::not_found(format!("Order {order_id} not found for Stripe session.")))?;
    let buyer_uid = order
        .get("buyerUid")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let total_cents = expected_eur_charge(&order);
    let discount_pkn = order
        .get("pknDiscount")
        .and_then(|discount| discount.get("pkn"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let payment_status = order
        .get("paymentStatus")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if session.get("payment_status").and_then(Value::as_str) == Some("unpaid") {
        if payment_status == "pending_stripe" {
            let _ = firestore
                .update_document(
                    &firestore.document_path(store::ORDERS, order_id),
                    &json!({ "paymentStatus": "processing", "updatedAt": store::now_iso() }),
                    Some(&["paymentStatus", "updatedAt"]),
                )
                .await;
        }
        return Ok(());
    }

    if payment_status == "paid" {
        // A Stripe retry must resume a half-finished fulfilment.
        let _ = super::orders::fulfil_paid_eur_order(state, order_id).await;
        return Ok(());
    }

    if let Some(paid) = session.get("amount_total").and_then(Value::as_i64) {
        if paid != total_cents {
            return Err(ApiError::conflict(format!(
                "Stripe amount {paid} does not match order {total_cents}."
            )));
        }
    }
    let session_uid = session
        .get("metadata")
        .and_then(|metadata| metadata.get("pokoinUid"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !session_uid.is_empty() && !buyer_uid.is_empty() && session_uid != buyer_uid {
        return Err(ApiError::forbidden(
            "Stripe session uid does not match order buyer.",
        ));
    }

    if discount_pkn > 0 {
        let op = LedgerOp::unlock(
            &buyer_uid,
            discount_pkn,
            "order_discount_consumed",
            false,
        )
        .with_ref(order_id);
        let _ = store::apply(firestore, &op).await;
    }

    let mut patch = json!({
        "paymentStatus": "paid",
        "status": "paid",
        "paidAt": store::now_iso(),
        "updatedAt": store::now_iso(),
        "stripePaidSessionId": session.get("id").and_then(Value::as_str).unwrap_or_default(),
        "stripePaymentIntentId": session.get("payment_intent").cloned().unwrap_or(Value::Null),
    });
    if discount_pkn > 0 {
        if let Some(object) = patch.as_object_mut() {
            object.insert(
                "pknDiscount".into(),
                json!({
                    "pkn": discount_pkn,
                    "state": "consumed",
                    "consumedAt": store::now_iso(),
                }),
            );
        }
    }
    firestore
        .set_document(&firestore.document_path(store::ORDERS, order_id), &patch)
        .await?;

    // Commit the stock hold, write the Sold-on-Pokoin rows and queue the seller
    // notifications. Seller Transfers still await delivery.
    let _ = super::orders::fulfil_paid_eur_order(state, order_id).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// /api/stripe-connect-onboard
// ---------------------------------------------------------------------------

fn connect_status(account: &Value) -> (&'static str, bool) {
    let ready = account.get("charges_enabled").and_then(Value::as_bool) == Some(true)
        && account.get("payouts_enabled").and_then(Value::as_bool) == Some(true);
    if ready {
        return ("READY", true);
    }
    if account.get("details_submitted").and_then(Value::as_bool) == Some(true) {
        return ("pending", false);
    }
    ("onboarding", false)
}
pub async fn stripe_connect_onboard_get(
    State(state): State<DomainState>,
    super::PublicAuthedUser(claims): super::PublicAuthedUser,
) -> Result<Response, ApiError> {
    let stripe = state.stripe()?;
    // Connect state lives on the Firestore user document (`users/{uid}`), exactly
    // like `stripe-connect-onboard.js` — never in a separate profile table.
    let firestore = state.firestore()?;
    let profile = store::read_user(firestore, &claims.uid).await?;
    let account_id = profile
        .get("stripeConnectAccountId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if account_id.is_empty() {
        return Ok(private_json(json!({
            "stripeConnectAccountId": "",
            "stripeConnectStatus": "not_started",
            "ready": false,
        })));
    }
    let account = stripe.retrieve_account(&account_id).await?;
    let (status, ready) = connect_status(&account);
    firestore
        .update_document(
            &firestore.document_path(store::USERS, &claims.uid),
            &json!({
                "stripeConnectAccountId": account_id,
                "stripeConnectStatus": status,
                "updatedAt": store::now_iso(),
            }),
            Some(&["stripeConnectAccountId", "stripeConnectStatus", "updatedAt"]),
        )
        .await?;
    Ok(private_json(json!({
        "stripeConnectAccountId": account_id,
        "stripeConnectStatus": status,
        "ready": ready,
    })))
}

pub async fn stripe_connect_onboard_post(
    State(state): State<DomainState>,
    super::PublicAuthedUser(claims): super::PublicAuthedUser,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let stripe = state.stripe()?;
    let firestore = state.firestore()?;
    let user_path = firestore.document_path(store::USERS, &claims.uid);
    let profile = store::read_user(firestore, &claims.uid).await?;
    let mut account_id = profile
        .get("stripeConnectAccountId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let stored_country = crate::domain::country::normalize_country(
        profile
            .get("shipFromCountry")
            .and_then(Value::as_str)
            .or_else(|| profile.get("ship_from_country").and_then(Value::as_str))
            .unwrap_or_default(),
    );
    let had_country = !stored_country.is_empty();

    if account_id.is_empty() {
        let country = if had_country {
            stored_country.clone()
        } else {
            crate::domain::country::ship_from_country_from_request(&headers)
        };
        if country.is_empty() {
            return Err(ApiError::bad_request(
                "Set ship-from country on Profile before Stripe Connect.",
            ));
        }
        let account = stripe
            .create_account(vec![
                ("type".into(), "express".into()),
                ("country".into(), country.clone()),
                ("capabilities[card_payments][requested]".into(), "true".into()),
                ("capabilities[transfers][requested]".into(), "true".into()),
                ("metadata[pokoinUid]".into(), claims.uid.clone()),
            ])
            .await?;
        account_id = account
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if account_id.is_empty() {
            return Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                "Stripe did not return a Connect account id.",
            ));
        }
        // `shipFromCountrySource` follows the Node rule: keep the profile's
        // existing source when it already had a country, otherwise this was an
        // IP seed.
        let source = if had_country {
            profile
                .get("shipFromCountrySource")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("user")
                .to_string()
        } else {
            "ip".to_string()
        };
        firestore
            .update_document(
                &user_path,
                &json!({
                    "stripeConnectAccountId": account_id,
                    "stripeConnectStatus": "onboarding",
                    "shipFromCountry": country,
                    "shipFromCountrySource": source,
                    "updatedAt": store::now_iso(),
                }),
                Some(&[
                    "stripeConnectAccountId",
                    "stripeConnectStatus",
                    "shipFromCountry",
                    "shipFromCountrySource",
                    "updatedAt",
                ]),
            )
            .await?;
    }

    let site = state.config().public_site_url.trim_end_matches('/').to_string();
    let return_url = body
        .get("returnUrl")
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .unwrap_or_else(|| format!("{site}/profile?stripe=return"));
    let refresh_url = body
        .get("refreshUrl")
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .unwrap_or_else(|| format!("{site}/profile?stripe=refresh"));
    let link = stripe
        .create_account_link(vec![
            ("account".into(), account_id.clone()),
            ("refresh_url".into(), refresh_url),
            ("return_url".into(), return_url),
            ("type".into(), "account_onboarding".into()),
        ])
        .await?;
    Ok(private_json(json!({
        "url": link.get("url").cloned().unwrap_or(Value::Null),
        "stripeConnectAccountId": account_id,
        "stripeConnectStatus": "onboarding",
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packages_match_the_stripe_lookup_keys() {
        assert_eq!(
            package_lookup_key(500),
            Some("pkn_starter_1000_pkn_500_eur")
        );
        assert_eq!(
            package_lookup_key(2500),
            Some("pkn_collector_5000_pkn_2500_eur")
        );
        assert_eq!(
            package_lookup_key(10000),
            Some("pkn_validator_20000_pkn_10000_eur")
        );
        assert_eq!(package_lookup_key(1234), None);
    }

    #[test]
    fn connect_status_reads_the_stripe_account_flags() {
        assert_eq!(
            connect_status(&json!({ "charges_enabled": true, "payouts_enabled": true })),
            ("READY", true)
        );
        assert_eq!(
            connect_status(&json!({ "charges_enabled": true, "details_submitted": true })),
            ("pending", false)
        );
        assert_eq!(connect_status(&json!({})), ("onboarding", false));
    }
}

/// Stripe collects the EUR total after consuming the buyer's PKN discount.
fn expected_eur_charge(order: &Value) -> i64 {
    let numeric = |value: Option<&Value>| value.and_then(|value| value.as_f64().or_else(|| value.as_str().and_then(|s| s.parse::<f64>().ok()))).filter(|n| n.is_finite()).unwrap_or(0.0);
    (numeric(order.get("totalEURCents")) - numeric(order.get("pknDiscount").and_then(|d| d.get("eurCents")))) as i64
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    #[test] fn stripe_eur_total_subtracts_discount() {
        assert_eq!(expected_eur_charge(&json!({"totalEURCents": 1000, "pknDiscount":{"pkn":100,"eurCents":50}})), 950);
        assert_eq!(expected_eur_charge(&json!({"totalEURCents":"800"})), 800);
    }
    #[test] fn webhook_errors_are_plain_text() {
        let response = stripe_text(StatusCode::BAD_REQUEST, "Webhook Error: signature rejected.");
        assert_eq!(response.headers()["content-type"], "text/plain; charset=utf-8");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
