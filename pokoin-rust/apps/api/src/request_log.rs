//! Request diagnostics contain the route template, the URI path and counters only, never query/body/auth.
//! The layer wraps the whole router, so `route` is often "unmatched"; `path` says which endpoint it was.
use std::sync::atomic::{AtomicU64,Ordering};
use std::time::{Instant,SystemTime,UNIX_EPOCH};
use axum::{extract::{Request,MatchedPath,State},middleware::Next,response::Response,http::HeaderValue};
static SEQUENCE:AtomicU64=AtomicU64::new(1);
/// Requests the API is serving now (sequence -> path, start), read by the stall watchdog.
static IN_FLIGHT:std::sync::Mutex<std::collections::BTreeMap<u64,(String,Instant)>>=std::sync::Mutex::new(std::collections::BTreeMap::new());
/// Removes the request from IN_FLIGHT when it finishes or its connection drops.
struct InFlight(u64);
impl InFlight{fn start(seq:u64,path:&str)->Self{if let Ok(mut m)=IN_FLIGHT.lock(){m.insert(seq,(path.to_owned(),Instant::now()));}InFlight(seq)}}
impl Drop for InFlight{fn drop(&mut self){if let Ok(mut m)=IN_FLIGHT.lock(){m.remove(&self.0);}}}
/// `path:age_ms` for the `limit` oldest in-flight requests, plus the total count.
pub fn in_flight_summary(limit:usize)->String{
 let Ok(m)=IN_FLIGHT.lock() else{return String::new()};
 let mut out:Vec<String>=m.values().take(limit).map(|(p,t)|format!("{p}:{}",t.elapsed().as_millis())).collect();
 out.push(format!("total={}",m.len()));out.join(",")
}
pub async fn log_request(State(state):State<crate::AppState>,req:Request,next:Next)->Response{
 state.requests.fetch_add(1,Ordering::Relaxed);
 let started=Instant::now();
 let route=req.extensions().get::<MatchedPath>().map(|p|p.as_str()).unwrap_or("unmatched").to_owned();
 let method=req.method().as_str().to_owned();
 let path:String=req.uri().path().chars().take(160).collect();
 let seq=SEQUENCE.fetch_add(1,Ordering::Relaxed);
 let request_id=format!("rust-{:x}-{:x}",SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),seq);
 let in_flight=InFlight::start(seq,&path);
 let (mut res,timing)=pokoin_api_common::stages::scope(next.run(req)).await;
 drop(in_flight);
 if let Ok(v)=HeaderValue::from_str(&timing){res.headers_mut().insert("server-timing",v);}
 let status=res.status().as_u16();let duration_ms=started.elapsed().as_millis() as u64;
 res.headers_mut().insert("x-pokoin-runtime",HeaderValue::from_static("rust"));
 if let Ok(v)=HeaderValue::from_str(&state.config.release){res.headers_mut().insert("x-pokoin-release",v);}
 if let Ok(v)=HeaderValue::from_str(&request_id){res.headers_mut().insert("x-request-id",v);}
 if status>=500{state.errors.fetch_add(1,Ordering::Relaxed);tracing::error!(%request_id,%route,%path,%method,status,duration_ms,"http_request");}
 else if duration_ms>=500{tracing::warn!(%request_id,%route,%path,%method,status,duration_ms,"slow_http_request");}
 else{tracing::info!(%request_id,%route,%path,%method,status,duration_ms,"http_request");}
 res
}

/// `POST /api/client-error`: an SPA route crash (Solid `Errored` boundary).
/// Logged as one structured line; never stored, never echoed. Bodies above
/// 8 KiB are refused and every field is clipped.
pub async fn client_error(body:axum::body::Bytes)->axum::http::StatusCode{
 if body.len()>8192{return axum::http::StatusCode::PAYLOAD_TOO_LARGE}
 let v:serde_json::Value=serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
 let clip=|k:&str,n:usize|->String{v.get(k).and_then(serde_json::Value::as_str).unwrap_or("").chars().filter(|c|!c.is_control()||*c=='\n').take(n).collect()};
 tracing::warn!(route=%clip("route",200),message=%clip("message",500),stack=%clip("stack",3000),release=%clip("release",80),signed_in=%clip("signedIn",8),"client_error");
 axum::http::StatusCode::NO_CONTENT
}
