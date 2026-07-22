//! `ronu validate <module.json> [more...]` — validate module content from the
//! command line. Exit 0 = every file valid (warnings allowed), 1 = any errors,
//! 2 = usage error.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let files = match args.split_first() {
        Some((_, rest)) if !rest.is_empty() && rest[0] == "validate" => &rest[1..],
        _ => {
            eprintln!("usage: ronu validate <module.json> [module.json ...]");
            return ExitCode::from(2);
        }
    };
    if files.is_empty() {
        eprintln!("usage: ronu validate <module.json> [module.json ...]");
        return ExitCode::from(2);
    }

    let mut failed = false;
    for file in files {
        let content = match std::fs::read_to_string(file) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("{file}: unreadable — {e}");
                failed = true;
                continue;
            }
        };
        let value: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("{file}: not JSON — {e}");
                failed = true;
                continue;
            }
        };
        let result = ronu::validate_module(&value);
        let flag = if result.valid { "VALID" } else { "INVALID" };
        println!(
            "{file}: {flag} ({} errors, {} warnings)",
            result.errors.len(),
            result.warnings.len()
        );
        for issue in &result.errors {
            println!("  error  {}  {}", issue.code, issue.message);
        }
        for issue in &result.warnings {
            println!("  warn   {}  {}", issue.code, issue.message);
        }
        if !result.valid {
            failed = true;
        }
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
