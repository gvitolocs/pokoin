use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvalSystem {
    Brain,
    Hermes,
}

#[derive(Debug, Clone)]
pub struct Args {
    pub questions: PathBuf,
    pub out: PathBuf,
    pub brain: bool,
    pub hermes_url: Option<String>,
    pub providers: Option<String>,
    pub only: Vec<String>,
    pub repeat: u32,
    pub concurrency: usize,
}

const USAGE: &str = "\
poko-eval — compare Rust Poko brain with Hermes on a fixed question set

Usage:
  poko-eval --questions <path> --out <path> [--brain] [--hermes-url URL] [options]

Options:
  --brain                 Run each question through the in-process brain
  --hermes-url URL        POST each question to Hermes /api/poko/chat
  --providers LIST        Override POKO_BRAIN_PROVIDERS (comma-separated)
  --only id1,id2          Run only these question ids
  --repeat N              Repeat each (question, system) pair N times (default 1)
  --concurrency N         Parallel questions (default 1)
  -h, --help              Show this help
";

pub fn parse_args(argv: &[String]) -> Result<Args, String> {
    if argv.iter().any(|arg| arg == "-h" || arg == "--help") {
        return Err(USAGE.to_string());
    }
    let mut questions = None;
    let mut out = None;
    let mut brain = false;
    let mut hermes_url = None;
    let mut providers = None;
    let mut only = Vec::new();
    let mut repeat = 1u32;
    let mut concurrency = 1usize;

    let mut index = 0usize;
    while index < argv.len() {
        let arg = &argv[index];
        match arg.as_str() {
            "--questions" => {
                index += 1;
                questions = Some(next_value(argv, &mut index, "--questions")?);
            }
            "--out" => {
                index += 1;
                out = Some(next_value(argv, &mut index, "--out")?);
            }
            "--brain" => {
                brain = true;
                index += 1;
            }
            "--hermes-url" => {
                index += 1;
                hermes_url = Some(next_value(argv, &mut index, "--hermes-url")?);
            }
            "--providers" => {
                index += 1;
                providers = Some(next_value(argv, &mut index, "--providers")?);
            }
            "--only" => {
                index += 1;
                let raw = next_value(argv, &mut index, "--only")?;
                only = raw
                    .split(',')
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
                    .collect();
            }
            "--repeat" => {
                index += 1;
                repeat =
                    parse_positive_u32(&next_value(argv, &mut index, "--repeat")?, "--repeat")?;
            }
            "--concurrency" => {
                index += 1;
                concurrency = parse_positive_usize(
                    &next_value(argv, &mut index, "--concurrency")?,
                    "--concurrency",
                )?;
            }
            other => return Err(format!("unknown argument: {other}\n{USAGE}")),
        }
    }

    let questions = questions.ok_or_else(|| format!("--questions is required\n{USAGE}"))?;
    let out = out.ok_or_else(|| format!("--out is required\n{USAGE}"))?;
    if !brain && hermes_url.is_none() {
        return Err(format!("pass --brain and/or --hermes-url\n{USAGE}"));
    }
    if repeat == 0 {
        return Err("--repeat must be at least 1".to_string());
    }
    if concurrency == 0 {
        return Err("--concurrency must be at least 1".to_string());
    }

    Ok(Args {
        questions: PathBuf::from(questions),
        out: PathBuf::from(out),
        brain,
        hermes_url,
        providers,
        only,
        repeat,
        concurrency,
    })
}

fn next_value(argv: &[String], index: &mut usize, flag: &str) -> Result<String, String> {
    if *index >= argv.len() {
        return Err(format!("{flag} requires a value\n{USAGE}"));
    }
    let value = argv[*index].clone();
    *index += 1;
    if value.is_empty() {
        return Err(format!("{flag} requires a non-empty value\n{USAGE}"));
    }
    Ok(value)
}

fn parse_positive_u32(value: &str, flag: &str) -> Result<u32, String> {
    let parsed = value
        .parse::<u32>()
        .map_err(|_| format!("{flag} must be a positive integer"))?;
    if parsed == 0 {
        return Err(format!("{flag} must be at least 1"));
    }
    Ok(parsed)
}

fn parse_positive_usize(value: &str, flag: &str) -> Result<usize, String> {
    let parsed = value
        .parse::<usize>()
        .map_err(|_| format!("{flag} must be a positive integer"))?;
    if parsed == 0 {
        return Err(format!("{flag} must be at least 1"));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_required_flags() {
        let argv = vec![
            "--questions".into(),
            "q.jsonl".into(),
            "--out".into(),
            "/tmp/out.jsonl".into(),
            "--brain".into(),
            "--hermes-url".into(),
            "http://localhost/chat".into(),
            "--only".into(),
            "a,b".into(),
            "--repeat".into(),
            "2".into(),
            "--concurrency".into(),
            "4".into(),
            "--providers".into(),
            "gemini,deepseek".into(),
        ];
        let args = parse_args(&argv).expect("parse");
        assert!(args.brain);
        assert_eq!(args.hermes_url.as_deref(), Some("http://localhost/chat"));
        assert_eq!(args.only, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(args.repeat, 2);
        assert_eq!(args.concurrency, 4);
        assert_eq!(args.providers.as_deref(), Some("gemini,deepseek"));
    }

    #[test]
    fn requires_at_least_one_system() {
        let argv = vec![
            "--questions".into(),
            "q.jsonl".into(),
            "--out".into(),
            "/tmp/out.jsonl".into(),
        ];
        assert!(parse_args(&argv).is_err());
    }
}
