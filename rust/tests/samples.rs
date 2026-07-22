//! Differential conformance test: the Rust validator must agree with the
//! reference TS validator on every repo sample. The expected results below are
//! captured from `validator/cli.ts` — if the port diverges, this fails.

use std::path::PathBuf;

fn validate_sample(name: &str) -> ronu::ValidationResult {
    let path: PathBuf = [env!("CARGO_MANIFEST_DIR"), "..", "samples", name, "module.json"]
        .iter()
        .collect();
    let content = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let value: serde_json::Value = serde_json::from_str(&content).expect("sample is JSON");
    ronu::validate_module(&value)
}

fn sorted_codes(issues: &[ronu::Issue]) -> Vec<String> {
    let mut codes: Vec<String> = issues.iter().map(|i| i.code.clone()).collect();
    codes.sort();
    codes
}

fn assert_sample(name: &str, valid: bool, errors: &[&str], warnings: &[&str]) {
    let result = validate_sample(name);
    assert_eq!(result.valid, valid, "{name}: valid flag");
    assert_eq!(sorted_codes(&result.errors), errors, "{name}: error codes");
    let mut want: Vec<String> = warnings.iter().map(|s| s.to_string()).collect();
    want.sort();
    assert_eq!(sorted_codes(&result.warnings), want, "{name}: warning codes");
}

#[test]
fn fantasy_series_quiz_is_clean() {
    assert_sample("fantasy-series-quiz", true, &[], &[]);
}

#[test]
fn hello_ronu_is_clean() {
    assert_sample("hello-ronu", true, &[], &[]);
}

#[test]
fn legacy_branching_sample_warns_no_default_and_unreachable() {
    // Exercises legacy node types (router/decisionPath) + stringified condition
    // criteria + an orphan node.
    assert_sample(
        "legacy-branching-sample",
        true,
        &[],
        &["condition/no-default", "node/unreachable"],
    );
}

#[test]
fn under_the_sink_warns_no_environment() {
    assert_sample("under-the-sink", true, &[], &["scene/no-environment"]);
}

// ── Negative fixtures: broken modules must be caught ────────────────────────

fn validate_json(v: serde_json::Value) -> ronu::ValidationResult {
    ronu::validate_module(&v)
}

#[test]
fn dangling_connection_is_an_error() {
    let result = validate_json(serde_json::json!({
        "nodes": [
            { "id": "a", "type": "message", "config": { "isStart": true, "connection": "ghost" }, "connection": "ghost" }
        ]
    }));
    assert!(!result.valid);
    assert!(result.errors.iter().any(|e| e.code == "connection/dangling"));
}

#[test]
fn missing_start_node_is_an_error() {
    let result = validate_json(serde_json::json!({
        "nodes": [ { "id": "a", "type": "message", "config": {} } ]
    }));
    assert!(result.errors.iter().any(|e| e.code == "module/no-start"));
}

#[test]
fn two_start_nodes_is_an_error() {
    let result = validate_json(serde_json::json!({
        "nodes": [
            { "id": "a", "type": "message", "config": { "isStart": true } },
            { "id": "b", "type": "message", "config": { "isStart": true } }
        ]
    }));
    assert!(result.errors.iter().any(|e| e.code == "module/multiple-starts"));
}

#[test]
fn action_targeting_unknown_variable_is_an_error() {
    let result = validate_json(serde_json::json!({
        "nodes": [
            { "id": "a", "type": "choice", "config": { "isStart": true,
              "choices": [ { "id": "c1", "text": "x", "connection": "a",
                "actions": [ { "variableId": "nope", "operator": "increment", "value": 1 } ] } ] } }
        ]
    }));
    assert!(result.errors.iter().any(|e| e.code == "action/unknown-variable"));
}

#[test]
fn non_object_content_is_an_error() {
    let result = validate_json(serde_json::json!([1, 2, 3]));
    assert!(!result.valid);
    assert!(result.errors.iter().any(|e| e.code == "content/invalid"));
}
