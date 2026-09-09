//! `ronu validate [--json] <module.json> [more...]` — validate module content
//! from the command line. Exit 0 = every file valid (warnings allowed), 1 = any
//! errors, 2 = usage error.
//!
//! `--json` prints one JSON object per file (one per line):
//! `{ "file", "valid", "errors": [...], "warnings": [...] }`, each issue being
//! `{ code, message, nodeId? }`. That is what a differential test against
//! another validator reads.

use std::process::ExitCode;

const USAGE: &str = "usage: ronu validate [--json] <module.json> [module.json ...]";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let rest = match args.split_first() {
        Some((_, rest)) if !rest.is_empty() && rest[0] == "validate" => &rest[1..],
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    let json = rest.first().map(|s| s == "--json").unwrap_or(false);
    let files = if json { &rest[1..] } else { rest };
    if files.is_empty() {
        eprintln!("{USAGE}");
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
        if json {
            let mut line = serde_json::to_value(&result).unwrap_or(serde_json::Value::Null);
            if let Some(obj) = line.as_object_mut() {
                obj.insert("file".to_string(), serde_json::Value::String(file.clone()));
            }
            println!("{line}");
            if !result.valid {
                failed = true;
            }
            continue;
        }
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
