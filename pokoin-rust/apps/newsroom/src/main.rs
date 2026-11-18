use anyhow::{bail, Context, Result};
use pokoin_newsroom::{
    cadence, editorial, game, handover, iso,
    model::{Budget, Provider},
    store, templates, text, website,
};
use serde_json::{json, Value};
use std::{
    env,
    path::{Path, PathBuf},
    time::Duration,
};

fn option(args: &[String], key: &str) -> Option<String> {
    args.windows(2).find(|w| w[0] == key).map(|w| w[1].clone())
}
fn main() {
    let args: Vec<_> = env::args().skip(1).collect();
    // Load env before starting Tokio worker threads. Never log its contents.
    let result = (|| {
        if let Some(file) = option(&args, "--env-file") {
            store::load_env_file(Path::new(&file))?;
        }
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?
            .block_on(run(&args))
    })();
    if let Err(error) = result {
        eprintln!("newsroom: {error:#}");
        std::process::exit(1);
    }
}
async fn run(args: &[String]) -> Result<()> {
    let command = args.first().map(String::as_str).unwrap_or("help");
    let dir = option(args, "--data-dir")
        .map(PathBuf::from)
        .unwrap_or_else(store::data_dir);
    let now = option(args, "--now")
        .map(|s| pokoin_newsroom::timestamp(&s).context("invalid --now"))
        .transpose()?
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    match command {
        "status" => {
            println!(
                "{}",
                json!({"productionReady": handover::PARITY_COMPLETE, "gaps": handover::PARITY_GAPS})
            );
        }
        "preflight" => {
            let state = handover::validate_state(&dir)?;
            if args.iter().any(|s| s == "--activate") {
                handover::activation_preflight()?;
            }
            println!("{state}");
        }
        "snapshot" => {
            let dest =
                PathBuf::from(option(args, "--output").context("snapshot requires --output")?);
            println!("{}", handover::snapshot(&dir, &dest)?);
        }
        "capture-h42" => capture_h42(args).await?,
        "plan" => {
            let stories = store::load_array(&dir.join(store::STORIES));
            let records = store::load_array(&dir.join(store::RECORDS));
            let state = store::strict_read(&dir.join(store::STATE))?;
            println!("{}", cadence::plan(&stories, &records, &state, now));
        }
        "dry-run" => dry_run(args, &dir, now).await?,
        "serve" => {
            let bind = option(args, "--bind")
                .context("serve requires an explicit --bind 127.0.0.1:<workspace-port>")?;
            let address: std::net::SocketAddr = bind.parse()?;
            if !address.ip().is_loopback() {
                bail!("standalone H42 listener must be loopback");
            }
            let config = website::Website {
                data_dir: dir.clone(),
                legacy_data_dir: option(args, "--legacy-data-dir")
                    .map(PathBuf::from)
                    .unwrap_or(dir),
                export_token: env::var("POKO_NEWS_EXPORT_TOKEN").unwrap_or_default(),
            };
            axum::serve(
                tokio::net::TcpListener::bind(address).await?,
                website::router(config),
            )
            .with_graceful_shutdown(async {
                let _ = tokio::signal::ctrl_c().await;
            })
            .await?;
        }
        "run" => {
            handover::activation_preflight()?;
            bail!("publisher loop unavailable");
        }
        "ready" => {
            handover::activation_preflight()?;
            bail!("publisher readiness unavailable");
        }
        _ => {
            println!(
                "pokoin-newsroom status | preflight [--activate] | snapshot --output DIR | plan"
            );
            println!("capture-h42 --base URL --output FILE; six public GETs of /api/poko/news.");
            println!("dry-run --input FILE --output FILE [--env-file FILE] [--max-model-calls N]");
            println!("serve --bind IP:PORT; use --data-dir DIR and --now RFC3339 for replay.");
            println!("Production run/ready fail closed until J17 parity is complete.");
        }
    }
    Ok(())
}
/// Read-only H42 golden capture: six public GETs, no token, no auth header, no write
/// to any newsroom state. Non-2xx answers are recorded, never treated as failures.
async fn capture_h42(args: &[String]) -> Result<()> {
    let base = option(args, "--base").context("capture-h42 requires --base URL")?;
    let output = PathBuf::from(
        option(args, "--output").context("capture-h42 requires --output outside live state")?,
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .context("capture-h42 needs a plain HTTP client")?;
    let mut rows = Vec::new();
    for query in [
        "",
        "?slug=missing-rust-parity",
        "?story=missing-rust-parity",
        "?export=invalid",
        "?export=all",
        "?export=published",
    ] {
        let response = client
            .get(format!("{base}/api/poko/news{query}"))
            .send()
            .await
            .with_context(|| format!("GET /api/poko/news{query}"))?;
        let status = response.status().as_u16();
        let mut headers = serde_json::Map::new();
        for name in [
            "content-type",
            "cache-control",
            "access-control-allow-origin",
        ] {
            headers.insert(
                name.to_string(),
                response
                    .headers()
                    .get(name)
                    .and_then(|value| value.to_str().ok())
                    .map(Value::from)
                    .unwrap_or(Value::Null),
            );
        }
        let body: Value = response
            .json()
            .await
            .with_context(|| format!("GET /api/poko/news{query} is not JSON"))?;
        rows.push(
            json!({"query": query.strip_prefix('?').unwrap_or(query), "status": status,
            "headers": Value::Object(headers), "body": body}),
        );
    }
    let captured = rows.len();
    let document = json!({"base": base, "capturedAt": chrono::Utc::now().to_rfc3339(),
        "method": "GET", "rows": rows});
    store::atomic_json(&output, &document)?;
    println!("captured {captured} public GET responses");
    Ok(())
}
async fn dry_run(args: &[String], dir: &Path, now: i64) -> Result<()> {
    let input = PathBuf::from(
        option(args, "--input").context("dry-run requires --input captured evidence fixture")?,
    );
    let output = PathBuf::from(
        option(args, "--output").context("dry-run requires --output outside live state")?,
    );
    let live = std::fs::canonicalize(dir)?;
    let parent = output.parent().context("output needs parent")?;
    if std::fs::canonicalize(parent)?.starts_with(&live) {
        bail!("dry-run output must be outside newsroom data directory");
    }
    let fixture = store::strict_read(&input)?;
    let limit = option(args, "--max-model-calls")
        .map(|s| s.parse::<usize>())
        .transpose()?
        .unwrap_or(4);
    if limit > 10 {
        bail!("read-only acceptance run capped at 10 model calls");
    }
    let budget = Budget::new(limit);
    let provider = Provider::from_env(budget.clone())?;
    let stories = store::load_array(&dir.join(store::STORIES));
    let records = store::load_array(&dir.join(store::RECORDS));
    let state = store::strict_read(&dir.join(store::STATE))?;
    let pack = &fixture["pack"];
    // newsroom-publisher.mjs:91 — a daily slot accepts one specialist or official outlet.
    let allow_single = cadence::cadence_for(game(pack)).kind == "daily";
    // pipeline.js:132-134 — an existing record makes the story covered unless the
    // pack is an update, and a covered story is never skipped for its score.
    let story_id = {
        let id = text(pack, "canonicalStoryId");
        if id.is_empty() {
            text(pack, "storyId")
        } else {
            id
        }
    };
    let existing = store::find_record_by_story(&records, story_id);
    let covered = existing.is_some() && pack["isUpdate"] != true;
    let hints = templates::hints(pack, now);
    let valid_templates = templates::valid_templates(&hints);
    let worthiness = templates::worthiness(pack, &hints, covered, allow_single);
    let passes = if existing.is_none() && worthiness["decision"] != "article" {
        let decision = worthiness["decision"].as_str().unwrap_or("skip");
        Ok(
            json!({"ok": true, "action": "skip", "reason": format!("editorial_worthiness_{decision}"), "worthiness": worthiness.clone()}),
        )
    } else {
        editorial::run_passes(
            &provider,
            pack,
            &hints,
            &valid_templates,
            fixture["memory"].as_str().unwrap_or(""),
            now,
        )
        .await
    };
    let plan = cadence::plan(&stories, &records, &state, now);
    let mut report = json!({"at": iso(now), "dryRun": true, "inputKind": "captured-evidence-pack",
        "productionReady": false, "worthiness": worthiness, "plan": plan, "modelCalls": limit - budget.remaining()});
    let failure = match passes {
        Ok(passes) => {
            report["passes"] = passes.clone();
            if passes["ok"] == true {
                None
            } else {
                // A model failure is a failed acceptance run, not a draft. Only the
                // taxonomy reason is reported: never a body, key or raw response.
                Some(format!("draft not produced: {}", text(&passes, "reason")))
            }
        }
        Err(error) => {
            report["error"] = json!(error.to_string());
            Some(error.to_string())
        }
    };
    store::atomic_json(&output, &report)?;
    if let Some(failure) = failure {
        bail!(
            "{failure}; report saved ({} calls)",
            limit - budget.remaining()
        );
    }
    println!(
        "{}",
        json!({"ok": true, "modelCalls": limit - budget.remaining(),
        "draftProduced": report["passes"]["draft"].is_object()})
    );
    Ok(())
}
