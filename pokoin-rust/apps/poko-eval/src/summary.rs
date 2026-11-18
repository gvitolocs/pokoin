use std::collections::BTreeMap;

use crate::output::RunRecord;
use crate::question::Question;
use crate::stats::{mean_u32, percentile, tool_rate, SystemStats};

const TRUNCATE: usize = 400;

pub fn render_summary_table(stats: &[SystemStats]) -> String {
    let mut lines = Vec::new();
    for system in stats {
        lines.push(format!("## system: {}", system.system));
        lines.push(system_overview_table(system));
        lines.push(String::new());
        lines.push("### tool-use rate by kind".to_string());
        lines.push(kind_tool_table(system));
        lines.push(String::new());
        lines.push("### p50 ms by kind".to_string());
        lines.push(kind_latency_table(system));
        lines.push(String::new());
    }
    lines.join("\n")
}

fn system_overview_table(system: &SystemStats) -> String {
    let mut ms = system.ms.clone();
    ms.sort_unstable();
    let p50 = percentile(&ms, 50.0);
    let p95 = percentile(&ms, 95.0);
    let max = ms.last().copied().unwrap_or(0);
    let mean_llm = mean_u32(&system.llm_calls);
    format!(
        "| n | errors | p50 ms | p95 ms | max ms | mean llm_calls |\n\
         |---:|---:|---:|---:|---:|---:|\n\
         | {} | {} | {} | {} | {} | {:.2} |",
        system.count, system.errors, p50, p95, max, mean_llm
    )
}

fn kind_tool_table(system: &SystemStats) -> String {
    let mut lines = vec![
        "| kind | n | tool-use rate |".to_string(),
        "| --- | ---: | ---: |".to_string(),
    ];
    for (kind, stats) in &system.by_kind {
        lines.push(format!(
            "| {} | {} | {:.1}% |",
            kind,
            stats.count,
            tool_rate(stats.tool_uses, stats.count) * 100.0
        ));
    }
    lines.join("\n")
}

fn kind_latency_table(system: &SystemStats) -> String {
    let mut lines = vec![
        "| kind | n | p50 ms |".to_string(),
        "| --- | ---: | ---: |".to_string(),
    ];
    for (kind, stats) in &system.by_kind {
        let mut ms = stats.ms.clone();
        ms.sort_unstable();
        lines.push(format!(
            "| {} | {} | {} |",
            kind,
            stats.count,
            percentile(&ms, 50.0)
        ));
    }
    lines.join("\n")
}

pub fn render_summary_markdown(
    stats: &[SystemStats],
    questions: &[Question],
    replies: &BTreeMap<String, (Option<String>, Option<String>)>,
) -> String {
    let mut out = String::from("# poko-eval summary\n\n");
    out.push_str(&render_summary_table(stats));
    out.push_str("\n## replies (brain vs Hermes)\n\n");
    out.push_str("| id | expect | brain reply | hermes reply |\n| --- | --- | --- | --- |\n");
    for question in questions {
        let (brain, hermes) = replies.get(&question.id).cloned().unwrap_or((None, None));
        out.push_str(&format!(
            "| {} | {} | {} | {} |\n",
            escape_cell(&question.id),
            escape_cell(&truncate(&question.expect, TRUNCATE)),
            escape_cell(&truncate(brain.as_deref().unwrap_or("—"), TRUNCATE)),
            escape_cell(&truncate(hermes.as_deref().unwrap_or("—"), TRUNCATE)),
        ));
    }
    out
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out = text.chars().take(max).collect::<String>();
    out.push('…');
    out
}

fn escape_cell(text: &str) -> String {
    text.replace('|', "\\|").replace('\n', " ")
}

pub fn collect_replies(
    records: &[RunRecord],
) -> BTreeMap<String, (Option<String>, Option<String>)> {
    let mut map: BTreeMap<String, (Option<String>, Option<String>)> = BTreeMap::new();
    for record in records {
        let entry = map.entry(record.id.clone()).or_insert((None, None));
        match record.system.as_str() {
            "brain" if entry.0.is_none() => entry.0 = Some(record.reply.clone()),
            "hermes" if entry.1.is_none() => entry.1 = Some(record.reply.clone()),
            _ => {}
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::RunRecord;

    fn sample_record(system: &str, kind: &str, ms: u64, tools: &[&str], error: bool) -> RunRecord {
        RunRecord {
            id: "q1".into(),
            kind: kind.into(),
            lang: "en".into(),
            system: system.into(),
            provider: String::new(),
            model: String::new(),
            ms,
            llm_calls: 1,
            tools: tools.iter().map(|name| name.to_string()).collect(),
            reply: "hello".into(),
            cards: Vec::new(),
            blocked: false,
            error: error.then_some("fail".into()),
        }
    }

    #[test]
    fn summary_table_includes_percentiles() {
        let mut stats = SystemStats {
            system: "brain".into(),
            count: 0,
            errors: 0,
            ms: Vec::new(),
            llm_calls: Vec::new(),
            by_kind: BTreeMap::new(),
        };
        stats.absorb(&sample_record(
            "brain",
            "market",
            100,
            &["card_price"],
            false,
        ));
        stats.absorb(&sample_record("brain", "chat", 200, &[], false));
        let table = render_summary_table(&[stats]);
        assert!(table.contains("p50 ms"));
        assert!(table.contains("tool-use rate"));
        assert!(table.contains("market"));
    }

    #[test]
    fn markdown_lists_questions() {
        let questions = vec![Question {
            id: "a".into(),
            lang: "en".into(),
            kind: "chat".into(),
            message: "hi".into(),
            expect: "greet".into(),
            game: None,
            history: Vec::new(),
            context: Vec::new(),
        }];
        let replies = BTreeMap::from([(
            "a".to_string(),
            (Some("brain says hi".into()), Some("hermes says hi".into())),
        )]);
        let md = render_summary_markdown(&[], &questions, &replies);
        assert!(md.contains("brain says hi"));
        assert!(md.contains("hermes says hi"));
    }
}
