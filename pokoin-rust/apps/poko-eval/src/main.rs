use std::fs::{self, File};
use std::io::Write;
use std::sync::Arc;

use tokio::sync::{Mutex, Semaphore};

use poko_eval::{
    brain_context, collect_replies, hermes_context, load_questions, parse_args,
    render_summary_markdown, render_summary_table, run_brain, run_hermes, Args, EvalSystem,
    RunRecord, SystemStats,
};

#[derive(Clone)]
struct Job {
    system: EvalSystem,
    question_index: usize,
}

#[tokio::main]
async fn main() {
    // Brain warnings (tool and provider failures) go to stderr; RUST_LOG filters them.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .try_init();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&argv) {
        Ok(args) => args,
        Err(message) => {
            if message.starts_with("poko-eval") {
                print!("{message}");
            } else {
                eprintln!("{message}");
            }
            std::process::exit(if message.starts_with("poko-eval") {
                0
            } else {
                2
            });
        }
    };
    if let Err(error) = run(args).await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run(args: Args) -> Result<(), String> {
    let questions = load_questions(&args.questions, &args.only)?;
    if let Some(parent) = args.out.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create output dir {}: {error}", parent.display()))?;
        }
    }

    let brain = if args.brain {
        Some(brain_context(args.providers.as_deref())?)
    } else {
        None
    };
    let hermes = match args.hermes_url.as_deref() {
        Some(url) => Some(hermes_context(url)?),
        None => None,
    };

    let jobs = build_jobs(&args, questions.len());
    let file = File::create(&args.out)
        .map_err(|error| format!("create output {}: {error}", args.out.display()))?;
    let writer = Arc::new(Mutex::new(file));
    let records: Arc<Mutex<Vec<RunRecord>>> = Arc::new(Mutex::new(Vec::new()));
    let semaphore = Arc::new(Semaphore::new(args.concurrency));
    let questions = Arc::new(questions);

    let mut handles = Vec::new();
    for job in jobs {
        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|error| error.to_string())?;
        let writer = writer.clone();
        let records = records.clone();
        let questions = questions.clone();
        let brain = brain.clone();
        let hermes = hermes.clone();
        handles.push(tokio::spawn(async move {
            let question = &questions[job.question_index];
            let record = match job.system {
                EvalSystem::Brain => {
                    let ctx = brain.as_ref().expect("brain job without brain context");
                    run_brain(ctx, question).await
                }
                EvalSystem::Hermes => {
                    let ctx = hermes.as_ref().expect("hermes job without hermes context");
                    run_hermes(ctx, question).await
                }
            };
            let line = serde_json::to_string(&record)
                .map_err(|error| format!("serialize record: {error}"))?;
            {
                let mut file = writer.lock().await;
                writeln!(file, "{line}").map_err(|error| format!("write output: {error}"))?;
            }
            records.lock().await.push(record);
            drop(permit);
            Ok(())
        }));
    }

    for handle in handles {
        handle
            .await
            .map_err(|error| format!("task join: {error}"))?
            .map_err(|error: String| error)?;
    }

    let records = records.lock().await.clone();
    let mut brain_stats = SystemStats {
        system: "brain".into(),
        ..SystemStats::default()
    };
    let mut hermes_stats = SystemStats {
        system: "hermes".into(),
        ..SystemStats::default()
    };
    for record in &records {
        match record.system.as_str() {
            "brain" => brain_stats.absorb(record),
            "hermes" => hermes_stats.absorb(record),
            _ => {}
        }
    }
    let stats: Vec<SystemStats> = [brain_stats, hermes_stats]
        .into_iter()
        .filter(|system| system.count > 0)
        .collect();
    let table = render_summary_table(&stats);
    println!("{table}");
    let summary_path = format!("{}.summary.md", args.out.display());
    let replies = collect_replies(&records);
    let markdown = render_summary_markdown(&stats, questions.as_ref(), &replies);
    fs::write(&summary_path, markdown)
        .map_err(|error| format!("write summary {summary_path}: {error}"))?;
    Ok(())
}

fn build_jobs(args: &Args, question_count: usize) -> Vec<Job> {
    let mut jobs = Vec::new();
    for question_index in 0..question_count {
        for _repeat in 0..args.repeat {
            if args.brain {
                jobs.push(Job {
                    system: EvalSystem::Brain,
                    question_index,
                });
            }
            if args.hermes_url.is_some() {
                jobs.push(Job {
                    system: EvalSystem::Hermes,
                    question_index,
                });
            }
        }
    }
    jobs
}
