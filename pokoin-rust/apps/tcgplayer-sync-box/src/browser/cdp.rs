//! Thin CDP client. The websocket is accepted only when its host is 127.0.0.1.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::portal::PortalError;

const CALL_TIMEOUT: Duration = Duration::from_secs(30);

enum Command {
    Call { method: String, params: Value, reply: oneshot::Sender<Result<Value, String>> },
    WaitLoad { reply: oneshot::Sender<Result<(), String>> },
    ClearEvents,
}

pub struct Cdp {
    tx: mpsc::UnboundedSender<Command>,
    alive: Arc<AtomicBool>,
}

impl Cdp {
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed) && !self.tx.is_closed()
    }

    pub async fn attach(port: u16) -> Result<Self, PortalError> {
        let websocket = page_websocket(port).await?;
        ensure_loopback(&websocket)?;
        let (stream, _) = connect_async(&websocket).await.map_err(|error| PortalError::Transient(error.to_string()))?;
        let (tx, rx) = mpsc::unbounded_channel();
        let alive = Arc::new(AtomicBool::new(true));
        let flag = Arc::clone(&alive);
        tokio::spawn(async move {
            session(stream, rx).await;
            flag.store(false, Ordering::Relaxed);
        });
        let cdp = Self { tx, alive };
        cdp.call("Page.enable", json!({})).await?;
        cdp.call("Page.setLifecycleEventsEnabled", json!({"enabled": true})).await?;
        cdp.call("Runtime.enable", json!({})).await?;
        cdp.call("DOM.enable", json!({})).await?;
        Ok(cdp)
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, PortalError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::Call { method: method.to_string(), params, reply: reply_tx })
            .map_err(|_| PortalError::Transient("browser connection closed".to_string()))?;
        let response = tokio::time::timeout(CALL_TIMEOUT, reply_rx)
            .await
            .map_err(|_| PortalError::Transient(format!("{method} timed out")))?
            .map_err(|_| PortalError::Transient("browser connection closed".to_string()))?
            .map_err(PortalError::Transient)?;
        if let Some(error) = response.get("error") {
            let message = error["message"].as_str().unwrap_or("cdp error");
            return Err(PortalError::Transient(format!("{method}: {message}")));
        }
        Ok(response)
    }

    pub async fn clear_events(&self) -> Result<(), PortalError> {
        self.tx.send(Command::ClearEvents).map_err(|_| PortalError::Transient("browser connection closed".to_string()))
    }

    pub async fn wait_for_load(&self) -> Result<(), PortalError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(Command::WaitLoad { reply: reply_tx })
            .map_err(|_| PortalError::Transient("browser connection closed".to_string()))?;
        tokio::time::timeout(CALL_TIMEOUT, reply_rx)
            .await
            .map_err(|_| PortalError::Transient("page load timed out".to_string()))?
            .map_err(|_| PortalError::Transient("browser connection closed".to_string()))?
            .map_err(PortalError::Transient)
    }

    pub async fn evaluate(&self, expression: &str) -> Result<Value, PortalError> {
        let response = self
            .call("Runtime.evaluate", json!({"expression": expression, "returnByValue": true, "awaitPromise": true}))
            .await?;
        if response["result"]["exceptionDetails"].is_object() {
            let text = response["result"]["exceptionDetails"]["text"].as_str().unwrap_or("evaluate failed");
            return Err(PortalError::Transient(text.to_string()));
        }
        Ok(response["result"]["result"].get("value").cloned().unwrap_or(Value::Null))
    }

    pub async fn navigate(&self, url: &str) -> Result<(), PortalError> {
        self.clear_events().await?;
        self.call("Page.navigate", json!({"url": url})).await?;
        self.wait_for_load().await
    }

    pub async fn reload(&self) -> Result<(), PortalError> {
        self.clear_events().await?;
        self.call("Page.reload", json!({"ignoreCache": true})).await?;
        self.wait_for_load().await
    }

    pub async fn current_url(&self) -> Result<String, PortalError> {
        let value = self.evaluate("location.href").await?;
        Ok(value.as_str().unwrap_or("").to_string())
    }

    pub async fn click(&self, selector: &str) -> Result<(), PortalError> {
        let quoted = js_string(selector);
        self.evaluate(&format!("document.querySelector({quoted})?.scrollIntoView({{block:'center', inline:'center'}})"))
            .await?;
        let (x, y) = self.center(selector).await?;
        self.dispatch_mouse("mouseMoved", x, y, false).await?;
        self.dispatch_mouse("mousePressed", x, y, true).await?;
        self.dispatch_mouse("mouseReleased", x, y, true).await?;
        Ok(())
    }

    pub async fn select_all_and_clear(&self) -> Result<(), PortalError> {
        self.key("keyDown", "a", "KeyA", 65, 2).await?;
        self.key("keyUp", "a", "KeyA", 65, 2).await?;
        self.key("keyDown", "Backspace", "Backspace", 8, 0).await?;
        self.key("keyUp", "Backspace", "Backspace", 8, 0).await?;
        Ok(())
    }

    pub async fn insert_text(&self, text: &str) -> Result<(), PortalError> {
        self.call("Input.insertText", json!({"text": text})).await?;
        Ok(())
    }

    async fn center(&self, selector: &str) -> Result<(f64, f64), PortalError> {
        let doc = self.call("DOM.getDocument", json!({"depth": 1, "pierce": true})).await?;
        let root = doc["result"]["root"]["nodeId"].as_u64().unwrap_or(0);
        if root == 0 {
            return Err(PortalError::Transient("document has no root".to_string()));
        }
        let found = self.call("DOM.querySelector", json!({"nodeId": root, "selector": selector})).await?;
        let node = found["result"]["nodeId"].as_u64().unwrap_or(0);
        if node == 0 {
            return Err(PortalError::Permanent(format!("element not found: {selector}")));
        }
        let _ = self.call("DOM.focus", json!({"nodeId": node})).await;
        let model = self.call("DOM.getBoxModel", json!({"nodeId": node})).await?;
        let content = model["result"]["model"]["content"].as_array().cloned().unwrap_or_default();
        let nums: Vec<f64> = content.iter().filter_map(|value| value.as_f64()).collect();
        if nums.len() < 8 {
            return Err(PortalError::Transient(format!("element has no box: {selector}")));
        }
        let width = (nums[2] - nums[0]).abs();
        let height = (nums[5] - nums[1]).abs();
        if width < 1.0 || height < 1.0 {
            return Err(PortalError::Transient(format!("element has no box: {selector}")));
        }
        let x = (nums[0] + nums[2] + nums[4] + nums[6]) / 4.0;
        let y = (nums[1] + nums[3] + nums[5] + nums[7]) / 4.0;
        Ok((x, y))
    }

    async fn dispatch_mouse(&self, kind: &str, x: f64, y: f64, button: bool) -> Result<(), PortalError> {
        let mut params = json!({"type": kind, "x": x, "y": y});
        if button {
            params["button"] = json!("left");
            params["clickCount"] = json!(1);
        }
        self.call("Input.dispatchMouseEvent", params).await?;
        Ok(())
    }

    async fn key(&self, kind: &str, key: &str, code: &str, virtual_key: i64, modifiers: i64) -> Result<(), PortalError> {
        self.call(
            "Input.dispatchKeyEvent",
            json!({
                "type": kind,
                "key": key,
                "code": code,
                "windowsVirtualKeyCode": virtual_key,
                "nativeVirtualKeyCode": virtual_key,
                "modifiers": modifiers,
            }),
        )
        .await?;
        Ok(())
    }
}

fn js_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn is_load(event: &Value) -> bool {
    match event["method"].as_str() {
        Some("Page.loadEventFired") => true,
        Some("Page.lifecycleEvent") => event["params"]["name"] == "load",
        _ => false,
    }
}

async fn session(stream: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, mut rx: mpsc::UnboundedReceiver<Command>) {
    let (mut write, mut read) = stream.split();
    let mut pending: std::collections::HashMap<u64, oneshot::Sender<Result<Value, String>>> = std::collections::HashMap::new();
    let mut events: VecDeque<Value> = VecDeque::new();
    let mut load_waiter: Option<oneshot::Sender<Result<(), String>>> = None;
    let mut next = 1u64;
    loop {
        tokio::select! {
            biased;
            command = rx.recv() => {
                let Some(command) = command else { break };
                match command {
                    Command::ClearEvents => events.clear(),
                    Command::WaitLoad { reply } => {
                        if events.iter().any(is_load) {
                            events.retain(|event| !is_load(event));
                            let _ = reply.send(Ok(()));
                        } else {
                            load_waiter = Some(reply);
                        }
                    }
                    Command::Call { method, params, reply } => {
                        let id = next;
                        next += 1;
                        let message = json!({"id": id, "method": method, "params": params}).to_string();
                        pending.insert(id, reply);
                        if write.send(Message::Text(message.into())).await.is_err() {
                            if let Some(reply) = pending.remove(&id) {
                                let _ = reply.send(Err("browser connection closed".to_string()));
                            }
                            break;
                        }
                    }
                }
            }
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let value: Value = serde_json::from_str(text.as_ref()).unwrap_or(Value::Null);
                        if let Some(id) = value.get("id").and_then(|item| item.as_u64()) {
                            if let Some(reply) = pending.remove(&id) {
                                let _ = reply.send(Ok(value));
                            }
                        } else if value.get("method").is_some() {
                            if is_load(&value) {
                                if let Some(reply) = load_waiter.take() {
                                    let _ = reply.send(Ok(()));
                                } else {
                                    events.push_back(value);
                                }
                            } else if events.len() < 200 {
                                events.push_back(value);
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if write.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }
    for (_, reply) in pending {
        let _ = reply.send(Err("browser connection closed".to_string()));
    }
    if let Some(reply) = load_waiter {
        let _ = reply.send(Err("browser connection closed".to_string()));
    }
}

fn ensure_loopback(url: &str) -> Result<(), PortalError> {
    let rest = url
        .strip_prefix("ws://")
        .or_else(|| url.strip_prefix("wss://"))
        .ok_or_else(|| PortalError::Permanent(format!("refusing websocket {url}")))?;
    let host = rest.split('/').next().unwrap_or("");
    let name = host.rsplit_once(':').map(|(name, _)| name).unwrap_or(host);
    if name != "127.0.0.1" {
        return Err(PortalError::Permanent(format!("refusing websocket host {name}")));
    }
    Ok(())
}

async fn page_websocket(port: u16) -> Result<String, PortalError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| PortalError::Transient(error.to_string()))?;
    let list_url = format!("http://127.0.0.1:{port}/json/list");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(url) = fetch_page(&client, &list_url).await? {
            return Ok(url);
        }
        let _ = client.put(format!("http://127.0.0.1:{port}/json/new?about:blank")).send().await;
        if let Some(url) = fetch_page(&client, &list_url).await? {
            return Ok(url);
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(PortalError::Transient("chrome has no page target".to_string()))
}

async fn fetch_page(client: &reqwest::Client, list_url: &str) -> Result<Option<String>, PortalError> {
    let response = client.get(list_url).send().await.map_err(|error| PortalError::Transient(error.to_string()))?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let pages: Vec<Value> = response.json().await.map_err(|error| PortalError::Transient(error.to_string()))?;
    Ok(pages.into_iter().find(|page| page["type"] == "page").and_then(|page| page["webSocketDebuggerUrl"].as_str().map(str::to_string)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_hosts_other_than_loopback_are_refused() {
        assert!(ensure_loopback("ws://127.0.0.1:9/devtools/page/1").is_ok());
        let error = ensure_loopback("ws://example.com/devtools/page/1").unwrap_err();
        assert!(error.to_string().contains("refusing websocket host"));
    }
}
