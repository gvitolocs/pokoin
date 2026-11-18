//! Gemini speech-to-text and photo description. The API key is a header, never
//! a query parameter, and it is never logged.

use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use thiserror::Error;

const STT_TIMEOUT: Duration = Duration::from_secs(45);
const STT_ATTEMPTS: u32 = 3;
const STT_BACKOFF: Duration = Duration::from_millis(1500);
const VISION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Error)]
pub enum MediaError {
    #[error("{0}")]
    Message(String),
}

pub struct Gemini {
    http: reqwest::Client,
    api_key: String,
    model: String,
    base: String,
    /// Test hook. Production uses 1500 ms.
    backoff: Duration,
}

impl Gemini {
    pub fn new(http: reqwest::Client, api_key: String, model: String) -> Self {
        Self {
            http,
            api_key,
            model,
            base: "https://generativelanguage.googleapis.com".to_string(),
            backoff: STT_BACKOFF,
        }
    }

    pub fn with_base(mut self, base: impl Into<String>) -> Self {
        self.base = base.into().trim_end_matches('/').to_string();
        self
    }

    pub fn with_backoff(mut self, backoff: Duration) -> Self {
        self.backoff = backoff;
        self
    }

    pub async fn transcribe(
        &self,
        bytes: &[u8],
        mime_type: &str,
        caption: &str,
        kind: &str,
    ) -> Result<String, MediaError> {
        if self.api_key.is_empty() {
            return Err(MediaError::Message("GEMINI_API_KEY is missing".into()));
        }
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        let mut prompt = vec![
            "Transcribe the provided audio faithfully.".to_string(),
            "Return only the transcript text.".to_string(),
            "No markdown, no JSON, no notes.".to_string(),
        ];
        if !caption.is_empty() {
            prompt.push(format!("Caption/context: {caption}"));
        }
        prompt.push(format!("Source kind: {kind}"));
        prompt.push("Language can be Italian or English.".to_string());
        let body = json!({
            "contents": [{
                "role": "user",
                "parts": [
                    { "text": prompt.join("\n") },
                    { "inline_data": { "mime_type": mime_type, "data": data } }
                ]
            }],
            "generationConfig": { "temperature": 0 }
        });
        let mut last = MediaError::Message("Gemini STT API failed".into());
        for attempt in 1..=STT_ATTEMPTS {
            match self.generate(&body, STT_TIMEOUT).await {
                Ok(text) => {
                    let cleaned = cleanup_gemini_transcript(&text);
                    if cleaned.is_empty() {
                        return Err(MediaError::Message(
                            "Gemini STT API returned empty transcript".into(),
                        ));
                    }
                    return Ok(cleaned);
                }
                Err(error) => {
                    let retry = attempt < STT_ATTEMPTS && should_retry(&error);
                    last = error;
                    if retry {
                        let factor = 2u32.saturating_pow(attempt - 1);
                        tokio::time::sleep(self.backoff.saturating_mul(factor)).await;
                        continue;
                    }
                    return Err(last);
                }
            }
        }
        Err(last)
    }

    pub async fn describe(&self, bytes: &[u8], mime_type: &str, caption: &str) -> Option<String> {
        if self.api_key.is_empty() || bytes.is_empty() {
            return None;
        }
        let caption_line = if caption.trim().is_empty() {
            "(nessuna didascalia)"
        } else {
            caption.trim()
        };
        let prompt = format!(
            "You are Poko using vision as your eyes.\nReturn factual visual context only. Do not answer the user directly.\nDescribe visible text, Pokémon, trading cards (name, set, collector number if readable), objects and layout.\nIf the image is a chat screenshot, extract the conversation.\nUser caption/context: {caption_line}"
        );
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        let body = json!({
            "contents": [{
                "role": "user",
                "parts": [
                    { "text": prompt },
                    { "inline_data": { "mime_type": mime_type, "data": data } }
                ]
            }],
            "generationConfig": { "temperature": 0 }
        });
        match self.generate(&body, VISION_TIMEOUT).await {
            Ok(text) => {
                let cleaned = text.trim().to_string();
                if cleaned.is_empty() {
                    None
                } else {
                    Some(cleaned)
                }
            }
            Err(error) => {
                tracing::warn!(error = %error, "gemini vision failed");
                None
            }
        }
    }

    async fn generate(&self, body: &Value, timeout: Duration) -> Result<String, MediaError> {
        let url = format!("{}/v1beta/models/{}:generateContent", self.base, self.model);
        let response = self
            .http
            .post(url)
            .timeout(timeout)
            .header("content-type", "application/json")
            .header("x-goog-api-key", &self.api_key)
            .json(body)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    MediaError::Message(format!(
                        "Gemini STT API timed out after {}ms",
                        timeout.as_millis()
                    ))
                } else {
                    MediaError::Message(format!("Gemini STT API failed: {error}"))
                }
            })?;
        let status = response.status();
        let bytes = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(MediaError::Message(format!(
                "Gemini STT API failed {status}: {}",
                bytes.chars().take(600).collect::<String>()
            )));
        }
        let parsed: Value = serde_json::from_str(&bytes).map_err(|_| {
            MediaError::Message(format!(
                "Gemini STT API returned invalid JSON: {}",
                bytes.chars().take(300).collect::<String>()
            ))
        })?;
        let text = parsed
            .pointer("/candidates/0/content/parts")
            .and_then(|parts| parts.as_array())
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(|value| value.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err(MediaError::Message(
                "Gemini STT API returned empty transcript".into(),
            ));
        }
        Ok(text)
    }
}

fn should_retry(error: &MediaError) -> bool {
    let message = error.to_string();
    message.contains("Gemini STT API failed 429")
        || message.contains("Gemini STT API failed 503")
        || message.contains("timed out")
}

pub fn cleanup_gemini_transcript(value: &str) -> String {
    let raw = value.trim();
    if raw.is_empty() {
        return String::new();
    }
    static FENCE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)```(?:text)?\s*([\s\S]*?)```").expect("fence")
    });
    if let Some(caps) = FENCE.captures(raw) {
        caps.get(1)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default()
    } else {
        raw.to_string()
    }
}

pub fn classify_voice_transcription_error(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if regex_any(
        &lower,
        &[
            "insufficient_quota",
            "usage_limit_reached",
            "audio transcription failed 429",
        ],
    ) {
        return "openai_quota";
    }
    if regex_any(
        &lower,
        &[
            "prepayment credits are depleted",
            "resource_exhausted",
            "gemini stt api failed 429",
        ],
    ) {
        return "gemini_quota";
    }
    if regex_any(
        &lower,
        &[
            "api_key_service_blocked",
            "service_disabled",
            "permission_denied",
            "generativelanguage.googleapis.com",
            "gemini stt fallback failed",
        ],
    ) {
        return "gemini_blocked";
    }
    "generic"
}

fn regex_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

pub fn voice_failure_text(reason: &str) -> String {
    match reason {
        "gemini_blocked" => "Sono Poko: ho ricevuto il vocale, ma la chiave Gemini è bloccata per l'API richiesta. Devo abilitare/consentire Gemini API su quella key, poi riprovo subito.".to_string(),
        "openai_quota" => "Sono Poko: ho ricevuto il vocale, ma la trascrizione OpenAI è in quota esaurita e il fallback non è disponibile. Appena sblocco Gemini API, torno a trascriverli normalmente.".to_string(),
        "gemini_quota" => "Sono Poko: ho ricevuto il vocale, ma i crediti Gemini del progetto sono esauriti (429). Appena ricarico i crediti, torno a trascriverli normalmente.".to_string(),
        _ => "Sono Poko: ho ricevuto il messaggio audio, ma non sono riuscito a trascriverlo adesso.".to_string(),
    }
}

pub fn audio_too_long_text(duration: u64, max: u64) -> String {
    format!("Sono Poko: questo audio è troppo lungo ({duration}s). Limite attuale: {max}s.")
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

    use super::*;

    struct Seq {
        hits: Arc<AtomicUsize>,
    }

    impl Respond for Seq {
        fn respond(&self, request: &Request) -> ResponseTemplate {
            assert_eq!(
                request
                    .headers
                    .get("x-goog-api-key")
                    .and_then(|value| value.to_str().ok()),
                Some("test-key")
            );
            assert!(request.url.query().is_none());
            let body: Value = request.body_json().unwrap();
            assert_eq!(body["generationConfig"]["temperature"], 0);
            assert!(body["contents"][0]["parts"][0]["text"]
                .as_str()
                .unwrap()
                .contains("Transcribe the provided audio faithfully."));
            let n = self.hits.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                ResponseTemplate::new(503).set_body_string("unavailable")
            } else {
                ResponseTemplate::new(200).set_body_json(json!({
                    "candidates": [{
                        "content": { "parts": [{ "text": "```text\nciao poko\n```" }] }
                    }]
                }))
            }
        }
    }

    #[tokio::test]
    async fn stt_retries_503_then_strips_the_fence() {
        let server = MockServer::start().await;
        let hits = Arc::new(AtomicUsize::new(0));
        Mock::given(method("POST"))
            .and(path("/v1beta/models/gemini-2.5-flash-lite:generateContent"))
            .and(header("x-goog-api-key", "test-key"))
            .respond_with(Seq { hits: hits.clone() })
            .expect(2)
            .mount(&server)
            .await;
        let gemini = Gemini::new(
            reqwest::Client::new(),
            "test-key".into(),
            "gemini-2.5-flash-lite".into(),
        )
        .with_base(server.uri())
        .with_backoff(Duration::from_millis(1));
        let text = gemini
            .transcribe(b"abc", "audio/ogg", "", "voice")
            .await
            .unwrap();
        assert_eq!(text, "ciao poko");
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn classifier_keeps_the_four_replies() {
        assert_eq!(
            classify_voice_transcription_error("Gemini STT API failed 429: resource_exhausted"),
            "gemini_quota"
        );
        assert_eq!(
            classify_voice_transcription_error("API_KEY_SERVICE_BLOCKED"),
            "gemini_blocked"
        );
        assert_eq!(
            classify_voice_transcription_error("insufficient_quota"),
            "openai_quota"
        );
        assert_eq!(classify_voice_transcription_error("nope"), "generic");
        assert!(voice_failure_text("generic").contains("trascriverlo adesso"));
        assert!(cleanup_gemini_transcript("```text\nhey\n```") == "hey");
    }
}
