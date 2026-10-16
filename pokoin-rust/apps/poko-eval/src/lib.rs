//! In-process Poko brain vs Hermes evaluation harness (no writes).

mod args;
mod brain_run;
mod hermes_run;
mod output;
mod question;
mod stats;
mod summary;

pub use args::{parse_args, Args, EvalSystem};
pub use output::{EvalCard, RunRecord};
pub use question::{load_questions, Question};
pub use stats::{percentile, SystemStats};
pub use summary::{collect_replies, render_summary_markdown, render_summary_table};

pub use brain_run::{brain_context, run_brain, BrainContext};
pub use hermes_run::{hermes_context, run_hermes, HermesContext};
