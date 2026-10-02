use serde_json::Value;

pub async fn meili_health(base: &str, key: Option<&str>) -> bool {
    let url = format!("{}/health", base.trim_end_matches('/'));
    let mut request = reqwest::Client::new().get(url);
    if let Some(key) = key {
        request = request.header("Authorization", format!("Bearer {key}"));
    }
    request
        .timeout(std::time::Duration::from_millis(200))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

pub async fn meili_search(
    base: &str,
    key: Option<&str>,
    index: &str,
    query: &str,
    limit: u32,
) -> Result<Value, reqwest::Error> {
    let url = format!("{}/indexes/{index}/search", base.trim_end_matches('/'));
    let mut request = reqwest::Client::new().post(url).json(&serde_json::json!({
        "q": query,
        "limit": limit,
    }));
    if let Some(key) = key {
        request = request.header("Authorization", format!("Bearer {key}"));
    }
    request
        .timeout(std::time::Duration::from_millis(400))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
}
