//! The command line: parse, run, print, exit. Nothing here talks to the
//! database except through the library, and nothing here prints a URL.

use ct_ask_unpad as tool;

/// `plan` is the default, so `ct-ask-unpad --backup-table NAME` is a plan.
///
/// Exit codes: 0 for the usage text and for a command that did what it says;
/// 1 for a command that failed or, in `verify`, found a mismatch; 2 for a
/// command line that was never runnable.
#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let code = match tool::parse(argv) {
        Ok(args) => match tool::run(&args).await {
            Ok(report) => {
                // A write run prints each day as it commits, so what is left
                // here is only the lines that have not gone out yet.
                for line in report.pending() {
                    println!("{line}");
                }
                report.code()
            }
            Err(error) => {
                eprintln!("{}: {error}", tool::NAME);
                1
            }
        },
        Err(message) => {
            if message == tool::USAGE {
                println!("{message}");
                0
            } else {
                eprintln!("{message}");
                2
            }
        }
    };
    std::process::exit(code);
}
