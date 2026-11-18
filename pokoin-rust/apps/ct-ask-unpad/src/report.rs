//! What a command prints, and whether it says the work is right.

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
    lines: Vec<String>,
    failed: bool,
}

impl Report {
    pub fn line(&mut self, text: impl Into<String>) {
        self.lines.push(text.into());
    }

    /// A line that also marks the run as not right: `verify` found a mismatch.
    pub fn fail(&mut self, text: impl Into<String>) {
        self.failed = true;
        self.line(text);
    }

    pub fn failed(&self) -> bool {
        self.failed
    }

    pub fn lines(&self) -> &[String] {
        &self.lines
    }

    pub fn text(&self) -> String {
        let mut out = self.lines.join("\n");
        if !out.is_empty() {
            out.push('\n');
        }
        out
    }

    /// Exit status: 0 when the command did what it says, 1 when it found or made
    /// a mismatch. Errors are a separate path and exit 1 as well.
    pub fn code(&self) -> i32 {
        u8::from(self.failed).into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_is_a_nonzero_exit_and_a_line() {
        let mut report = Report::default();
        report.line("planned");
        assert_eq!(report.code(), 0);
        assert!(!report.failed());
        report.fail("mismatch on 2026-09-01");
        assert_eq!(report.code(), 1);
        assert!(report.failed());
        assert_eq!(
            report.text(),
            "planned\nmismatch on 2026-09-01\n",
            "{:?}",
            report.lines()
        );
    }

    #[test]
    fn empty_report_is_empty_text() {
        assert_eq!(Report::default().text(), "");
        assert_eq!(Report::default().code(), 0);
    }
}
