//! Native replacement of the Pi ct-deals static server and its authenticated proxy.
use std::path::{Path, PathBuf};
use std::time::Duration;
use axum::{Router, body::Body, extract::{State, Request}, http::{Method, StatusCode, Uri}, response::Response};
use tower::ServiceExt;
use serde_json::json;

#[derive(Clone)]
pub(crate) struct DealsState {
    root: PathBuf,
    token: String,
    api: Router,
    http: reqwest::Client,
    cm_base: String,
}

pub(crate) fn router(api: Router) -> Router {
    router_with(DealsState {
        root: std::env::var("CT_DEALS_ROOT").unwrap_or_else(|_| "/srv/pokoin/ct-deals/current/dist".into()).into(),
        token: std::env::var("DEAL_SCAN_TOKEN").unwrap_or_default().trim().into(),
        api,
        http: reqwest::Client::new(),
        cm_base: std::env::var("CT_DEALS_CM_API_BASE").unwrap_or_else(|_| "http://127.0.0.1:18100".into()).trim_end_matches('/').into(),
    })
}

fn router_with(state: DealsState) -> Router {
    Router::new().fallback(serve).with_state(state)
}

fn send(status: StatusCode, body: impl Into<Body>, content_type: &'static str) -> Response {
    let mut response=Response::new(body.into());
    *response.status_mut()=status;
    response.headers_mut().insert("content-type",axum::http::HeaderValue::from_static(content_type));
    response.headers_mut().insert("cache-control",axum::http::HeaderValue::from_static("no-store"));
    response
}

fn fail(status:StatusCode, message: &str)->Response {
    send(status,json!({"ok":false,"error":message}).to_string(),"application/json")
}

fn relative_path(uri:&Uri)->Option<PathBuf> {
    let decoded=percent_encoding::percent_decode_str(uri.path()).decode_utf8().ok()?;
    let rel=Path::new(decoded.trim_start_matches('/'));
    if rel.components().any(|c|matches!(c,std::path::Component::ParentDir|std::path::Component::RootDir|std::path::Component::Prefix(_))) {return None}
    Some(if rel.as_os_str().is_empty(){"index.html".into()}else{rel.into()})
}

async fn serve(State(state):State<DealsState>, req:Request)->Response {
    let uri=req.uri().clone();
    if uri.path()=="/api/scan" {
        if state.token.is_empty(){return fail(StatusCode::SERVICE_UNAVAILABLE,"DEAL_SCAN_TOKEN missing")}
        let target=format!("/api/cardtrader-deal-scan?{}",uri.query().unwrap_or(""));
        let request=match Request::builder().method(Method::GET).uri(target)
            .header("authorization",format!("Bearer {}",state.token)).header("accept","application/json")
            .body(Body::empty()) {Ok(r)=>r,Err(_)=>return fail(StatusCode::BAD_GATEWAY,"Invalid upstream request")};
        return match tokio::time::timeout(Duration::from_secs(120),state.api.oneshot(request)).await {
            Ok(Ok(mut response))=>{
                response.headers_mut().insert("content-type",axum::http::HeaderValue::from_static("application/json"));
                response.headers_mut().insert("cache-control",axum::http::HeaderValue::from_static("no-store"));response
            }
            _=>fail(StatusCode::BAD_GATEWAY,"Deal scan request failed"),
        }
    }
    if uri.path()=="/api/cm-scan" {
        let target=format!("{}/api/cm/deal-scan?{}",state.cm_base,uri.query().unwrap_or(""));
        return match state.http.get(target).header("accept","application/json").send().await {
            Ok(response)=>{let status=response.status();match response.bytes().await{
                Ok(body)=>send(status,body,"application/json"),
                Err(_)=>fail(StatusCode::BAD_GATEWAY,"Cardmarket scan response failed"),
            }}
            Err(_)=>fail(StatusCode::BAD_GATEWAY,"Cardmarket scan request failed"),
        }
    }
    if req.method()!=Method::GET&&req.method()!=Method::HEAD {
        return send(StatusCode::METHOD_NOT_ALLOWED,"method not allowed","text/plain; charset=utf-8")
    }
    let Some(relative)=relative_path(&uri)else{return send(StatusCode::FORBIDDEN,"forbidden","text/plain; charset=utf-8")};
    let root=match tokio::fs::canonicalize(&state.root).await{Ok(root)=>root,Err(_)=>return send(StatusCode::INTERNAL_SERVER_ERROR,"static site unavailable","text/plain; charset=utf-8")};
    let file=root.join(relative);
    let canonical=match tokio::fs::canonicalize(&file).await{
        Ok(file) if file.starts_with(&root)=>file,
        Ok(_)=>return send(StatusCode::FORBIDDEN,"forbidden","text/plain; charset=utf-8"),
        Err(_)=>root.join("index.html"),
    };
    let file=if tokio::fs::metadata(&canonical).await.is_ok_and(|m|m.is_dir()){root.join("index.html")}else{canonical};
    let content_type=match file.extension().and_then(|e|e.to_str()){
        Some("html")=>"text/html; charset=utf-8",Some("js")=>"text/javascript; charset=utf-8",Some("css")=>"text/css; charset=utf-8",
        Some("svg")=>"image/svg+xml",Some("ico")=>"image/x-icon",Some("json")=>"application/json",_=>"application/octet-stream",
    };
    match tokio::fs::read(file).await{
        Ok(bytes)=>{let length=bytes.len();let mut response=send(StatusCode::OK,if req.method()==Method::HEAD{Vec::new()}else{bytes},content_type);
            if let Ok(value)=length.to_string().parse(){response.headers_mut().insert("content-length",value);}response},
        Err(_)=>send(StatusCode::INTERNAL_SERVER_ERROR,"static site unavailable","text/plain; charset=utf-8"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    #[tokio::test]
    async fn static_fallback_head_and_proxy_contracts(){
        let root=std::env::temp_dir().join(format!("pokoin-deals-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        tokio::fs::create_dir_all(&root).await.unwrap();tokio::fs::write(root.join("index.html"),"native deals").await.unwrap();
        let state=DealsState{root:root.clone(),token:String::new(),api:Router::new(),http:reqwest::Client::new(),cm_base:"http://127.0.0.1:1".into()};
        let app=router_with(state);
        for (method,path,status)in [("GET","/",200),("GET","/missing",200),("HEAD","/",200),("POST","/",405),("GET","/%2e%2e/secret",403),("GET","/api/scan",503)]{
            let response=app.clone().oneshot(Request::builder().method(method).uri(path).body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(response.status().as_u16(),status,"{method} {path}");assert_eq!(response.headers()["cache-control"],"no-store");
            if method=="HEAD"{assert!(to_bytes(response.into_body(),100).await.unwrap().is_empty());}
        }
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
    #[tokio::test]
    async fn proxy_uses_native_router_and_keeps_auth_private(){
        async fn upstream(headers:axum::http::HeaderMap)->Response{assert_eq!(headers["authorization"],"Bearer private-test");send(StatusCode::OK,"{}","application/json")}
        let state=DealsState{root:"/missing".into(),token:"private-test".into(),api:Router::new().route("/api/cardtrader-deal-scan",axum::routing::get(upstream)),http:reqwest::Client::new(),cm_base:"http://127.0.0.1:1".into()};
        let response=router_with(state).oneshot(Request::builder().uri("/api/scan?q=test").body(Body::empty()).unwrap()).await.unwrap();assert_eq!(response.status(),StatusCode::OK);
        assert!(!response.headers().contains_key("authorization"));
    }
}
