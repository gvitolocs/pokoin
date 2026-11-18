//! What a command prints, and whether it says the work is right.

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
    lines: Vec<String>,
    /// Which of `lines` went out as they were appended, so the end of the run
    /// does not print them a second time.
    flushed: Vec<bool>,
    failed: bool,
}

impl Report {
    pub fn line(&mut self, text: impl Into<String>) {
        self.lines.push(text.into());
        self.flushed.push(false);
    }

    /// A line the operator has to see while the work is still moving: the day
    /// whose transaction just committed, for instance. It goes out now and the
    /// finished report does not print it again.
    pub fn landed(&mut self, text: impl Into<String>) {
        let text = text.into();
        println!("{text}");
        self.lines.push(text);
        self.flushed.push(true);
    }

    /// What the process still has to print. For a command that reports at the
    /// end this is every line; for `apply` it is nothing, because each line went
    /// out when it was made.
    pub fn pending(&self) -> Vec<String> {
        self.lines
            .iter()
            .enumerate()
            .filter(|(index, _)| !self.flushed[*index])
            .map(|(_, text)| text.clone())
            .collect()
    }

    /// A line that also marks the run as not right: `verify` found a mismatch.
    pub fn fail(&mut self, text: impl Into<String>) {
        self.failed = true;
        self.line(text);
    }

    /// The run is over and this day did not land. Say what is already committed
    /// before the error goes to stderr: the days before this one are in the
    /// table, this one is not, and running the same command again picks up here.
    pub fn stopped(&mut self, command: &str, total: usize, done: usize, day: &str) {
        self.landed(format!(
            "{command} stopped at day {} of {total}: {done} days committed, {day} did not",
            done + 1
        ));
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

    #[test]
    fn a_line_that_landed_is_not_printed_twice() {
        let mut report = Report::default();
        report.line("counting");
        report.landed("2026-09-01  written 12");
        report.line("done");
        assert_eq!(
            report.pending(),
            vec!["counting".to_string(), "done".to_string()]
        );
        // The finished text is the whole run, in order, landed lines included.
        assert_eq!(
            report.text(),
            "counting\n2026-09-01  written 12\ndone\n",
            "{:?}",
            report.lines()
        );
    }
}
