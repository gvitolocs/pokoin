use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct HistoryTurn {
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Question {
    pub id: String,
    pub lang: String,
    pub kind: String,
    pub message: String,
    pub expect: String,
    #[serde(default)]
    pub game: Option<String>,
    #[serde(default)]
    pub history: Vec<HistoryTurn>,
    /// Extra context blocks for the brain (what the chat handler adds: the open card page, photo hits, ...).
    #[serde(default)]
    pub context: Vec<String>,
}

impl Question {
    pub fn game_id(&self) -> &str {
        self.game
            .as_deref()
            .map(str::trim)
            .filter(|game| !game.is_empty())
            .unwrap_or("pokemon")
    }
}

pub fn load_questions(path: &Path, only: &[String]) -> Result<Vec<Question>, String> {
    let path_label = path.display();
    let file = File::open(path).map_err(|error| format!("open {path_label}: {error}"))?;
    let reader = BufReader::new(file);
    let filter = !only.is_empty();
    let mut questions = Vec::new();
    for (line_no, line) in reader.lines().enumerate() {
        let line = line.map_err(|error| format!("read {path_label} line {line_no}: {error}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let question: Question = serde_json::from_str(trimmed)
            .map_err(|error| format!("parse {path_label} line {}: {error}", line_no + 1))?;
        if filter && !only.iter().any(|id| id == &question.id) {
            continue;
        }
        questions.push(question);
    }
    if questions.is_empty() {
        return Err(format!("no questions loaded from {path_label}"));
    }
    Ok(questions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_question_line() {
        let raw = r#"{"id":"x","lang":"en","kind":"chat","message":"hi","expect":"greet"}"#;
        let question: Question = serde_json::from_str(raw).unwrap();
        assert_eq!(question.id, "x");
        assert_eq!(question.game_id(), "pokemon");
    }

    #[test]
    fn parses_history_and_game() {
        let raw = r#"{
            "id":"f","lang":"en","kind":"market","message":"and?","expect":"price",
            "game":"magic",
            "history":[{"role":"user","text":"hi"},{"role":"assistant","text":"hey"}]
        }"#;
        let question: Question = serde_json::from_str(raw).unwrap();
        assert_eq!(question.game_id(), "magic");
        assert_eq!(question.history.len(), 2);
    }
}
