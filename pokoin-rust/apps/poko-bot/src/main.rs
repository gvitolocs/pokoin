use std::sync::Arc;
use std::time::Duration;

use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::watch;

use poko_bot::api::ApiClient;
use poko_bot::config::Config;
use poko_bot::connect::ConnectState;
use poko_bot::health::{self, Metrics};
use poko_bot::history::{now_ms, History};
use poko_bot::media::Gemini;
use poko_bot::turn::{Deps, HttpServices};

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime");
    if let Err(error) = runtime.block_on(run()) {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

async fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let config = Arc::new(Config::from_env()?);
    config.log_effective();
    if let Err(error) = tokio::fs::create_dir_all(&config.state_dir).await {
        tracing::warn!(error = %error, path = %config.state_dir.display(), "state dir");
    }
    let history_path = config.state_dir.join("history.json");
    let history = Arc::new(History::load(&history_path));
    let metrics = Arc::new(Metrics::with_jev(poko_bot::jev::Jev::from_env()));
    metrics.telegram_enabled.store(
        config.telegram_enabled,
        std::sync::atomic::Ordering::Relaxed,
    );
    metrics
        .discord_enabled
        .store(config.discord_enabled, std::sync::atomic::Ordering::Relaxed);

    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()?;
    let services = Arc::new(HttpServices {
        api: ApiClient::new(
            http.clone(),
            config.api_base.clone(),
            config.service_token.clone().unwrap_or_default(),
        ),
        http: http.clone(),
        hermes_url: config.hermes_url.clone(),
        hermes_token: config.hermes_token.clone().unwrap_or_default(),
    });
    let gemini = config
        .gemini_api_key
        .clone()
        .map(|key| Arc::new(Gemini::new(http.clone(), key, config.gemini_model.clone())));
    let deps = Deps {
        services,
        connect: Arc::new(ConnectState::new()),
        history: history.clone(),
        metrics: metrics.clone(),
        config: config.clone(),
        gemini,
        typing: None,
        now_ms: Arc::new(now_ms),
        http,
    };

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let health = {
        let metrics = metrics.clone();
        let addr = config.health_addr;
        let rx = shutdown_rx.clone();
        tokio::spawn(async move {
            if let Err(error) = health::serve(addr, metrics, rx).await {
                tracing::error!(error = %error, "health server stopped");
            }
        })
    };
    let snapshot = {
        let history = history.clone();
        let path = history_path.clone();
        let mut rx = shutdown_rx.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = rx.changed() => break,
                    _ = tokio::time::sleep(Duration::from_secs(60)) => {
                        if history.is_dirty() {
                            if let Err(error) = history.save(&path) {
                                tracing::warn!(error = %error, "history snapshot failed");
                            }
                        }
                    }
                }
            }
        })
    };

    let mut workers = Vec::new();
    if config.telegram_enabled {
        match config.telegram_token.clone() {
            Some(token) => {
                let deps = deps.clone();
                let rx = shutdown_rx.clone();
                workers.push(tokio::spawn(poko_bot::telegram::run(token, deps, rx)));
            }
            None => tracing::error!("POKO_BOT_TELEGRAM=on but TELEGRAM_BOT_TOKEN_POKO is missing"),
        }
    }
    if config.discord_enabled {
        match config.discord_token.clone() {
            Some(token) => {
                let deps = deps.clone();
                let rx = shutdown_rx.clone();
                workers.push(tokio::spawn(poko_bot::discord::run(token, deps, rx)));
            }
            None => tracing::error!("POKO_BOT_DISCORD=on but DISCORD_BOT_TOKEN_POKO is missing"),
        }
    }

    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    tokio::select! {
        _ = terminate.recv() => tracing::info!("SIGTERM"),
        _ = interrupt.recv() => tracing::info!("SIGINT"),
    }
    let _ = shutdown_tx.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(3), async {
        for worker in workers {
            let _ = worker.await;
        }
    })
    .await;
    snapshot.abort();
    if let Err(error) = history.save(&history_path) {
        tracing::warn!(error = %error, "history snapshot on shutdown failed");
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), health).await;
    Ok(())
}
