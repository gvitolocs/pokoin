//! Username and display-name rules — a faithful port of `api/_username.js`.
//!
//! These are the allocation rules the profile screen, `register-email`,
//! `verify-email-signup`, `wallet-auth/verify`, `wallet-link` and
//! `wallet-link/complete` all share, so they live in one module with the exact
//! same predicates and error messages.

use serde_json::json;
use unicode_normalization::UnicodeNormalization;

use crate::error::{ApiError, Result};
use crate::firestore::{DocData, Firestore, Query};

/// The same 12 bases the Node module picks from for wallet/preferred handles.
pub const POKEMON_USERNAME_BASES: [&str; 12] = [
    "pikachu",
    "squirtle",
    "bulbasaur",
    "charmander",
    "eevee",
    "mew",
    "jigglypuff",
    "psyduck",
    "snorlax",
    "meowth",
    "vulpix",
    "dratini",
];

/// `baseUsernameFrom`: lowercase, strip the email domain, NFKD-decompose and
/// drop combining marks, remove everything that is not `[a-z0-9]`, then slice
/// to 24 (falling back to `pokoin` when shorter than 3).
pub fn base_username_from(value: &str) -> String {
    let raw: String = value
        .trim()
        .to_ascii_lowercase()
        .split('@')
        .next()
        .unwrap_or("")
        .nfkd()
        .filter(|character| !matches!(*character as u32, 0x0300..=0x036F))
        .filter(|character| character.is_ascii_alphanumeric())
        .collect();
    if raw.len() >= 3 {
        raw.chars().take(24).collect()
    } else {
        "pokoin".to_string()
    }
}

/// Visible name on the profile. Not the `@handle` and not an email.
pub fn normalize_display_name(value: &str) -> String {
    let without_controls: String = value
        .chars()
        .filter(|character| {
            let code = *character as u32;
            !(code <= 0x1f || code == 0x7f)
        })
        .collect();
    let collapsed: String = without_controls
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    collapsed.chars().take(40).collect()
}

/// `assertDisplayName`: 2+ characters, no email, no angle brackets, and at
/// least one letter or digit.
pub fn assert_display_name(value: &str) -> Result<String> {
    let clean = normalize_display_name(value);
    if clean.chars().count() < 2 {
        return Err(ApiError::bad_request("Name must be at least 2 characters."));
    }
    if clean.contains('@') || clean.contains('<') || clean.contains('>') {
        return Err(ApiError::bad_request("Use your name, not an email."));
    }
    let has_alphanumeric = clean.chars().any(|character| {
        character.is_ascii_alphanumeric()
            || matches!(character as u32, 0x00C0..=0x024F)
    });
    if !has_alphanumeric {
        return Err(ApiError::bad_request("Name needs a letter or number."));
    }
    Ok(clean)
}

/// Compact letters/digits for display-name prefix search (spaces stripped).
pub fn display_name_search_key(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .nfkd()
        .filter(|character| !matches!(*character as u32, 0x0300..=0x036F))
        .filter(|character| character.is_ascii_alphanumeric())
        .take(48)
        .collect()
}

/// `normalizeRequestedUsername`: exactly `^[a-z0-9]{3,32}$`.
pub fn normalize_requested_username(value: &str) -> Result<String> {
    let clean = value.trim().to_ascii_lowercase();
    let valid = (3..=32).contains(&clean.len())
        && clean
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
    if !valid {
        return Err(ApiError::bad_request(
            "Username must be 3-32 letters or numbers, with no spaces.",
        ));
    }
    Ok(clean)
}

pub fn random_pokemon_username_base() -> &'static str {
    POKEMON_USERNAME_BASES[rand::random::<usize>() % POKEMON_USERNAME_BASES.len()]
}

/// `isGeneratedWalletUsername`: a bare 40-hex handle, the wallet address inside
/// a `wallet:` uid, or the address-derived email prefix.
pub fn is_generated_wallet_username(username: &str, uid: &str, email: &str) -> bool {
    let normalized = username.trim().to_ascii_lowercase();
    let wallet_address = match uid.strip_prefix("wallet:") {
        Some(rest) => rest.trim_start_matches("0x").to_ascii_lowercase(),
        None => String::new(),
    };
    let email_prefix = email
        .split('@')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();

    let is_hex40 = |value: &str| {
        value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    };
    is_hex40(&normalized)
        || (!wallet_address.is_empty() && normalized == wallet_address)
        || (!email_prefix.is_empty() && normalized == email_prefix && is_hex40(&email_prefix))
}

pub fn should_replace_existing_username(
    username: &str,
    uid: &str,
    email: &str,
    force_pokemon: bool,
) -> bool {
    force_pokemon && is_generated_wallet_username(username, uid, email)
}

/// Current username on `users/{uid}`, lowercased and trimmed.
pub async fn existing_username(firestore: &Firestore, uid: &str) -> Result<String> {
    let snapshot = firestore.doc(format!("users/{uid}")).get().await?;
    Ok(snapshot
        .map(|document| document.get_str("username").trim().to_ascii_lowercase())
        .unwrap_or_default())
}

/// `assignUniqueUsername`: first free `<base>`, `<base>1`, `<base>2`, … within a
/// single transaction, writing both the `usernames` claim and the user profile.
pub async fn assign_unique_username(
    firestore: &Firestore,
    uid: &str,
    base: &str,
    display_name: &str,
    previous_username: &str,
) -> Result<String> {
    let uid_owned = uid.to_string();
    let clean_base = base_username_from(base);
    let display_name_owned = display_name.to_string();
    let previous_owned = previous_username.trim().to_ascii_lowercase();

    firestore
        .run_transaction(|transaction| {
            let uid = uid_owned.clone();
            let clean_base = clean_base.clone();
            let display_name = display_name_owned.clone();
            let previous = previous_owned.clone();
            Box::pin(async move {
                for suffix in 0..10_000u32 {
                    let candidate = if suffix == 0 {
                        clean_base.clone()
                    } else {
                        format!("{clean_base}{suffix}")
                    };
                    let username_ref = transaction.doc(&format!("usernames/{candidate}"));
                    let username_doc = transaction.get_doc(&username_ref).await?;
                    let owner = username_doc
                        .as_ref()
                        .map(|document| document.get_str("uid"))
                        .unwrap_or_default();
                    if username_doc.is_some() && owner != uid {
                        continue;
                    }

                    if !previous.is_empty() && previous != candidate {
                        let previous_ref = transaction.doc(&format!("usernames/{previous}"));
                        transaction.delete(&previous_ref);
                    }

                    let created_at = username_doc
                        .as_ref()
                        .and_then(|document| document.get("createdAt"));
                    let mut claim = DocData::new()
                        .string("uid", uid.clone())
                        .string("username", candidate.clone())
                        .string("displayName", display_name.clone())
                        .string(
                            "displayNameSearch",
                            display_name_search_key(&display_name),
                        );
                    claim = match created_at {
                        Some(value) => claim.set("createdAt", value),
                        None => claim.server_timestamp("createdAt"),
                    };
                    claim = claim.server_timestamp("updatedAt");
                    transaction.set(&username_ref, claim, true)?;

                    let user_ref = transaction.doc(&format!("users/{uid}"));
                    transaction.set(
                        &user_ref,
                        DocData::new()
                            .string("username", candidate.clone())
                            .string("usernameLower", candidate.clone())
                            .server_timestamp("updatedAt"),
                        true,
                    )?;
                    return Ok(candidate);
                }
                Err(ApiError::conflict("Could not allocate a unique username."))
            })
        })
        .await
}

/// `ensureUniqueUsername`: keep an existing handle unless it is a generated
/// wallet handle that the caller asked to replace with a Pokémon base.
pub async fn ensure_unique_username(
    firestore: &Firestore,
    uid: &str,
    email: &str,
    display_name: &str,
    prefer_pokemon: bool,
) -> Result<String> {
    let uid_owned = uid.to_string();
    let email_owned = email.to_string();
    let existing = firestore
        .run_transaction(|transaction| {
            let uid = uid_owned.clone();
            let email = email_owned.clone();
            Box::pin(async move {
                let user_ref = transaction.doc(&format!("users/{uid}"));
                let user_doc = transaction.get_doc(&user_ref).await?;
                let current = user_doc
                    .as_ref()
                    .map(|document| document.get_str("username").trim().to_ascii_lowercase())
                    .unwrap_or_default();
                if !current.is_empty()
                    && !should_replace_existing_username(&current, &uid, &email, prefer_pokemon)
                {
                    return Ok(Some(current));
                }
                Ok(None)
            })
        })
        .await?;

    if let Some(username) = existing {
        return Ok(username);
    }

    let previous = existing_username(firestore, uid).await?;
    let base = if prefer_pokemon {
        random_pokemon_username_base().to_string()
    } else {
        let source = if !email.is_empty() {
            email
        } else if !display_name.is_empty() {
            display_name
        } else {
            uid
        };
        base_username_from(source)
    };

    assign_unique_username(firestore, uid, &base, display_name, &previous).await
}

/// `claimExactUsername`: claim one specific handle, 409 when another uid owns it.
pub async fn claim_exact_username(
    firestore: &Firestore,
    uid: &str,
    username: &str,
    display_name: &str,
    email: &str,
    previous_username: &str,
) -> Result<String> {
    let clean = normalize_requested_username(username)?;
    let uid_owned = uid.to_string();
    let clean_owned = clean.clone();
    let display_owned = if display_name.is_empty() {
        clean.clone()
    } else {
        display_name.to_string()
    };
    let email_owned = email.to_string();
    let previous_owned = previous_username.trim().to_ascii_lowercase();

    firestore
        .run_transaction(|transaction| {
            let uid = uid_owned.clone();
            let clean = clean_owned.clone();
            let display_name = display_owned.clone();
            let email = email_owned.clone();
            let previous = previous_owned.clone();
            Box::pin(async move {
                let username_ref = transaction.doc(&format!("usernames/{clean}"));
                let username_doc = transaction.get_doc(&username_ref).await?;
                let owner = username_doc
                    .as_ref()
                    .map(|document| document.get_str("uid"))
                    .unwrap_or_default();
                if username_doc.is_some() && owner != uid {
                    return Err(ApiError::conflict("Username is already taken."));
                }

                if !previous.is_empty() && previous != clean {
                    let previous_ref = transaction.doc(&format!("usernames/{previous}"));
                    transaction.delete(&previous_ref);
                }

                let created_at = username_doc
                    .as_ref()
                    .and_then(|document| document.get("createdAt"));
                let mut claim = DocData::new()
                    .string("uid", uid.clone())
                    .string("username", clean.clone())
                    .string("displayName", display_name.clone())
                    .string(
                        "displayNameSearch",
                        display_name_search_key(&display_name),
                    );
                claim = match created_at {
                    Some(value) => claim.set("createdAt", value),
                    None => claim.server_timestamp("createdAt"),
                };
                claim = claim.server_timestamp("updatedAt");
                transaction.set(&username_ref, claim, true)?;

                let user_ref = transaction.doc(&format!("users/{uid}"));
                transaction.set(
                    &user_ref,
                    DocData::new()
                        .string("uid", uid.clone())
                        .string("email", email.clone())
                        .string("displayName", display_name.clone())
                        .string("username", clean.clone())
                        .string("usernameLower", clean.clone())
                        .server_timestamp("updatedAt"),
                    true,
                )?;
                Ok(clean)
            })
        })
        .await
}

/// `updateUniqueUsername`: no-op when the handle already matches.
pub async fn update_unique_username(
    firestore: &Firestore,
    uid: &str,
    desired_username: &str,
) -> Result<String> {
    let clean = normalize_requested_username(desired_username)?;
    let user = firestore.doc(format!("users/{uid}")).get().await?;
    let (previous, display_name, email) = match user {
        Some(document) => (
            document.get_str("username").trim().to_ascii_lowercase(),
            document.get_str("displayName"),
            document.get_str("email"),
        ),
        None => (String::new(), String::new(), String::new()),
    };
    if previous == clean {
        return Ok(clean);
    }
    let display = if display_name.is_empty() {
        clean.clone()
    } else {
        display_name
    };
    claim_exact_username(firestore, uid, &clean, &display, &email, &previous).await
}

/// `updateDisplayName`: write the profile + handle index in one batch, then
/// best-effort mirror to the Firebase Auth display name.
pub async fn update_display_name(
    firestore: &Firestore,
    auth: &crate::identity::FirebaseAuth,
    uid: &str,
    desired_name: &str,
) -> Result<String> {
    let clean = assert_display_name(desired_name)?;
    let user_ref = firestore.doc(format!("users/{uid}"));
    let user = user_ref.get().await?;
    let username = user
        .map(|document| document.get_str("username").trim().to_ascii_lowercase())
        .unwrap_or_default();

    let mut writes = user_ref.set_writes(
        &DocData::new()
            .string("displayName", clean.clone())
            .server_timestamp("updatedAt"),
        true,
    )?;
    let valid_username = (3..=32).contains(&username.len())
        && username
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
    if valid_username {
        let username_ref = firestore.doc(format!("usernames/{username}"));
        let mut extra = username_ref.set_writes(
            &DocData::new()
                .string("displayName", clean.clone())
                .string("displayNameSearch", display_name_search_key(&clean))
                .server_timestamp("updatedAt"),
            true,
        )?;
        writes.append(&mut extra);
    }
    firestore.commit_batch(writes).await?;

    // Node logs and continues when the Auth mirror fails.
    if let Err(error) = auth
        .update_user(
            uid,
            crate::identity::UpdateUser {
                display_name: Some(clean.clone()),
                ..Default::default()
            },
        )
        .await
    {
        tracing::warn!(%error, "display name auth update failed");
    }
    Ok(clean)
}

/// The `usernameForRequest` behaviour `ensure-username` relied on: claim an
/// explicit handle, otherwise repair/assign one.
pub async fn username_for_request(
    firestore: &Firestore,
    uid: &str,
    email: &str,
    display_name: &str,
    requested_username: Option<&str>,
) -> Result<String> {
    match requested_username.map(str::trim).filter(|value| !value.is_empty()) {
        Some(requested) => update_unique_username(firestore, uid, requested).await,
        None => ensure_unique_username(firestore, uid, email, display_name, false).await,
    }
}

/// Look up a handle owner, used by the profile/search paths.
pub async fn username_owner(firestore: &Firestore, username: &str) -> Result<Option<String>> {
    let clean = normalize_requested_username(username)?;
    let document = firestore.doc(format!("usernames/{clean}")).get().await?;
    Ok(document
        .map(|document| document.get_str("uid"))
        .filter(|uid| !uid.is_empty()))
}

/// Fetch up to `limit` handles owned by one uid (used by wallet linking to
/// detect a second linked wallet-style handle).
pub async fn usernames_for_uid(
    firestore: &Firestore,
    uid: &str,
    limit: i64,
) -> Result<Vec<(String, String)>> {
    let query = Query::collection("usernames")
        .where_eq("uid", uid.to_string())
        .limit(limit);
    let documents = firestore.run_query(&query).await?;
    Ok(documents
        .into_iter()
        .map(|document| (document.id(), document.get_str("uid")))
        .collect())
}

/// Serialize a claim payload for `setCustomUserClaims`.
pub fn custom_claims(entries: &[(&str, serde_json::Value)]) -> serde_json::Map<String, serde_json::Value> {
    let mut claims = serde_json::Map::new();
    for (key, value) in entries {
        claims.insert((*key).to_string(), value.clone());
    }
    claims
}

/// `pok_email_verified: true` — the claim `verify-email-signup` sets.
pub fn pok_email_verified_claims() -> serde_json::Map<String, serde_json::Value> {
    custom_claims(&[("pok_email_verified", json!(true))])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_username_strips_email_domain_and_accents() {
        assert_eq!(base_username_from("Giuseppe@example.com"), "giuseppe");
        assert_eq!(base_username_from("José"), "jose");
        assert_eq!(base_username_from("café-latte"), "cafelatte");
        assert_eq!(base_username_from("Müller_99"), "muller99");
    }

    #[test]
    fn base_username_falls_back_to_pokoin_and_caps_at_24() {
        assert_eq!(base_username_from("ab"), "pokoin");
        assert_eq!(base_username_from(""), "pokoin");
        assert_eq!(base_username_from("!!!"), "pokoin");
        let long = "a".repeat(40);
        assert_eq!(base_username_from(&long).len(), 24);
    }

    #[test]
    fn display_name_normalization_collapses_and_trims() {
        assert_eq!(normalize_display_name("  Ash   Ketchum  "), "Ash Ketchum");
        assert_eq!(normalize_display_name("Ash\u{0}Ketchum"), "AshKetchum");
        assert_eq!(normalize_display_name(&"a".repeat(60)).len(), 40);
    }

    #[test]
    fn display_name_assertions_match_the_node_messages() {
        let error = assert_display_name("a").unwrap_err();
        assert_eq!(error.message(), "Name must be at least 2 characters.");
        let error = assert_display_name("a@b.c").unwrap_err();
        assert_eq!(error.message(), "Use your name, not an email.");
        let error = assert_display_name("a<b").unwrap_err();
        assert_eq!(error.message(), "Use your name, not an email.");
        let error = assert_display_name("-- --").unwrap_err();
        assert_eq!(error.message(), "Name needs a letter or number.");
        assert_eq!(assert_display_name("Ash Ketchum").unwrap(), "Ash Ketchum");
        // Non-ASCII Latin letters count as a letter.
        assert_eq!(assert_display_name("José").unwrap(), "José");
    }

    #[test]
    fn search_key_is_compact_and_lowercase() {
        assert_eq!(display_name_search_key("Ash Ketchum"), "ashketchum");
        assert_eq!(display_name_search_key("  José  "), "jose");
        assert_eq!(display_name_search_key(&"x".repeat(60)).len(), 48);
    }

    #[test]
    fn requested_username_rules_match_the_node_regex() {
        assert_eq!(normalize_requested_username("  AsH99 ").unwrap(), "ash99");
        for bad in ["ab", "a", "", "ash ketchum", "ash-ketchum", "ash_99", "a".repeat(33).as_str()] {
            let error = normalize_requested_username(bad).unwrap_err();
            assert_eq!(
                error.message(),
                "Username must be 3-32 letters or numbers, with no spaces."
            );
        }
    }

    #[test]
    fn generated_wallet_usernames_are_detected() {
        let address = "0xabcdef0123456789abcdef0123456789abcdef01";
        let bare = "abcdef0123456789abcdef0123456789abcdef01";
        assert!(is_generated_wallet_username(bare, "uid", ""));
        // The 0x-prefixed form only counts as generated when it comes from the
        // wallet uid; Node tested the raw handle against ^[a-f0-9]{40}$.
        assert!(!is_generated_wallet_username(address, "uid", ""));
        assert!(is_generated_wallet_username(bare, &format!("wallet:{address}"), ""));
        assert!(is_generated_wallet_username(
            bare,
            &format!("wallet:{address}"),
            ""
        ));
        assert!(is_generated_wallet_username(
            bare,
            "uid",
            &format!("{bare}@wallet.pokoin.local")
        ));
        // A chosen handle is not a generated one.
        assert!(!is_generated_wallet_username("pikachu", "uid", "a@b.c"));
        assert!(!is_generated_wallet_username(
            "abcdef0123456789abcdef0123456789abcdef0",
            "uid",
            ""
        ));
    }

    #[test]
    fn replacement_only_happens_for_generated_handles_with_force() {
        let bare = "abcdef0123456789abcdef0123456789abcdef01";
        assert!(should_replace_existing_username(bare, "uid", "", true));
        assert!(!should_replace_existing_username(bare, "uid", "", false));
        assert!(!should_replace_existing_username("pikachu", "uid", "", true));
    }

    #[test]
    fn pokemon_bases_are_the_node_list() {
        assert_eq!(POKEMON_USERNAME_BASES.len(), 12);
        assert!(POKEMON_USERNAME_BASES.contains(&"pikachu"));
        assert!(POKEMON_USERNAME_BASES.contains(&"dratini"));
        for _ in 0..64 {
            assert!(POKEMON_USERNAME_BASES.contains(&random_pokemon_username_base()));
        }
    }

    #[test]
    fn claims_helper_builds_the_verified_email_claim() {
        let claims = pok_email_verified_claims();
        assert_eq!(claims.get("pok_email_verified"), Some(&json!(true)));
        assert_eq!(claims.len(), 1);
    }
}
