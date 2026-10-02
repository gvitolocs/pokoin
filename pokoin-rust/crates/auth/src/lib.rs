use thiserror::Error;

#[derive(Debug, Error)]
#[error("bearer token required")]
pub struct Unauthenticated;

pub fn bearer_token(header: Option<&str>) -> Result<&str, Unauthenticated> {
    let header = header.ok_or(Unauthenticated)?;
    let token = header
        .strip_prefix("Bearer ")
        .filter(|token| !token.is_empty());
    token.ok_or(Unauthenticated)
}
