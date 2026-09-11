//! Differential conformance test: the Rust validator must agree with the
//! platform's TS validator (`validateModuleContent`, the oracle) on every repo
//! sample. The expected results below are captured from the oracle's output as
//! of the 9 Sep 2026 sync (platform commit 5aa3ce4); if the port diverges,
//! this fails. The negative fixtures further down were run through the same
//! oracle and their codes confirmed identical.

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

#[test]
fn barrier_cream_round_is_clean() {
    // procedure (critical steps + early actions), dragToTarget (with a
    // distractor), canonical condition criteria, conversation with a rubric.
    assert_sample("barrier-cream-round", true, &[], &[]);
}

#[test]
fn margarets_room_is_clean() {
    // scene with nested hotspot interactions (procedure, multipleChoice,
    // dragToTarget, message), a character with rubric criteria, a hidden
    // discovery hotspot, and an early-exit rule.
    assert_sample("margarets-room", true, &[], &[]);
}

// ── Negative fixtures: broken modules must be caught ────────────────────────

fn validate_json(v: serde_json::Value) -> ronu::ValidationResult {
    ronu::validate_module(&v)
}

fn codes(issues: &[ronu::Issue]) -> Vec<String> {
    sorted_codes(issues)
}

/// A one-node module (plus an `end` node to connect to), the shape the
/// oracle-confirmed fixtures used.
fn one(node: serde_json::Value, variables: serde_json::Value, settings: Option<serde_json::Value>) -> serde_json::Value {
    let mut node = node;
    node["config"]["isStart"] = serde_json::Value::Bool(true);
    let end = serde_json::json!({ "id": "end", "type": "message", "config": { "title": "End", "content": "Done" } });
    let mut module = serde_json::json!({ "nodes": [node, end], "variables": variables });
    if let Some(settings) = settings {
        module["settings"] = settings;
    }
    module
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

// ── procedure / dragToTarget (Sep 2026) ─────────────────────────────────────
// Every expected code below was confirmed against the platform oracle.

#[test]
fn procedure_and_drag_to_target_are_known_types() {
    let result = validate_json(one(
        serde_json::json!({ "id": "p", "type": "procedure", "connection": "end", "config": { "title": "T", "question": "Do it",
            "procedureSteps": [ { "text": "Wash" }, { "text": "Consent", "critical": true, "ifEarly": "Not agreed",
                "earlyActions": [ { "variableId": "n", "operator": "increment", "value": 1 } ] } ],
            "procedureHaltOnCritical": true } }),
        serde_json::json!([{ "id": "n", "name": "missteps", "type": "number", "initialValue": 0 }]),
        None,
    ));
    assert!(result.valid);
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    let result = validate_json(one(
        serde_json::json!({ "id": "d", "type": "dragToTarget", "connection": "end", "config": { "title": "T", "question": "Place",
            "dragTargets": [ { "id": "t1", "label": "Bin" } ],
            // A distractor (no targetId) is deliberate and stays quiet.
            "dragItems": [ { "id": "i1", "label": "Sterile pack" }, { "id": "i2", "label": "Gloves", "targetId": "t1" } ] } }),
        serde_json::json!([]),
        None,
    ));
    assert!(result.valid);
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
}

#[test]
fn procedure_without_steps_warns() {
    let result = validate_json(one(
        serde_json::json!({ "id": "p", "type": "procedure", "connection": "end", "config": { "title": "Empty" } }),
        serde_json::json!([]),
        None,
    ));
    assert!(result.valid);
    assert_eq!(codes(&result.warnings), ["procedure/no-steps"]);
}

#[test]
fn critical_step_without_a_reason_warns() {
    // A blank ifEarly counts as missing, like the oracle's `!ifEarly?.trim()`.
    for if_early in [serde_json::Value::Null, serde_json::Value::String("   ".into())] {
        let result = validate_json(one(
            serde_json::json!({ "id": "p", "type": "procedure", "connection": "end", "config": { "title": "T",
                "procedureSteps": [ { "text": "Consent", "critical": true, "ifEarly": if_early } ] } }),
            serde_json::json!([]),
            None,
        ));
        assert_eq!(codes(&result.warnings), ["procedure/critical-no-reason"]);
    }
}

#[test]
fn procedure_early_actions_are_checked_like_any_action() {
    let unknown = validate_json(one(
        serde_json::json!({ "id": "p", "type": "procedure", "connection": "end", "config": { "title": "T",
            "procedureSteps": [ { "text": "Consent", "earlyActions": [ { "variableId": "ghost", "operator": "set_true" } ] } ] } }),
        serde_json::json!([]),
        None,
    ));
    assert!(!unknown.valid);
    assert_eq!(codes(&unknown.errors), ["action/unknown-variable"]);
    let bad_op = validate_json(one(
        serde_json::json!({ "id": "p", "type": "procedure", "connection": "end", "config": { "title": "T",
            "procedureSteps": [ { "text": "Consent", "earlyActions": [ { "variableId": "n", "operator": "toggle" } ] } ] } }),
        serde_json::json!([{ "id": "n", "name": "missteps", "type": "number", "initialValue": 0 }]),
        None,
    ));
    assert_eq!(codes(&bad_op.errors), ["action/bad-operator"]);
}

#[test]
fn drag_to_target_missing_either_side_warns() {
    let no_items = validate_json(one(
        serde_json::json!({ "id": "d", "type": "dragToTarget", "connection": "end", "config": { "title": "T",
            "dragTargets": [ { "id": "t1", "label": "Bin" } ], "dragItems": [] } }),
        serde_json::json!([]),
        None,
    ));
    assert_eq!(codes(&no_items.warnings), ["dragToTarget/incomplete"]);
    let no_targets = validate_json(one(
        serde_json::json!({ "id": "d", "type": "dragToTarget", "connection": "end", "config": { "title": "T",
            "dragItems": [ { "id": "i1", "label": "Gloves" } ] } }),
        serde_json::json!([]),
        None,
    ));
    assert_eq!(codes(&no_targets.warnings), ["dragToTarget/incomplete"]);
}

#[test]
fn drag_item_pointing_at_a_missing_place_warns() {
    let result = validate_json(one(
        serde_json::json!({ "id": "d", "type": "dragToTarget", "connection": "end", "config": { "title": "T",
            "dragTargets": [ { "id": "t1", "label": "Bin" } ],
            "dragItems": [ { "id": "i1", "label": "Gloves", "targetId": "gone" } ] } }),
        serde_json::json!([]),
        None,
    ));
    assert!(result.valid);
    assert_eq!(codes(&result.warnings), ["dragToTarget/orphan-item"]);
}

// ── matching / ranking / code ───────────────────────────────────────────────

#[test]
fn matching_to_a_missing_right_item_is_an_error() {
    let result = validate_json(one(
        serde_json::json!({ "id": "m", "type": "matching", "connection": "end", "config": { "title": "M",
            "matchingLeftItems": [ { "id": "l1", "text": "L", "correctRightId": "nope" } ],
            "matchingRightItems": [ { "id": "r1", "text": "R" } ] } }),
        serde_json::json!([]),
        None,
    ));
    assert!(!result.valid);
    assert_eq!(codes(&result.errors), ["matching/dangling-match"]);
    let empty = validate_json(one(
        serde_json::json!({ "id": "m", "type": "matching", "connection": "end", "config": { "title": "M",
            "matchingLeftItems": [], "matchingRightItems": [] } }),
        serde_json::json!([]),
        None,
    ));
    assert_eq!(codes(&empty.warnings), ["matching/empty"]);
}

#[test]
fn ranking_needs_two_items_and_accepts_rich_items() {
    let few = validate_json(one(
        serde_json::json!({ "id": "r", "type": "ranking", "connection": "end", "config": { "title": "R", "rankingItems": ["a"] } }),
        serde_json::json!([]),
        None,
    ));
    assert_eq!(codes(&few.warnings), ["ranking/too-few"]);
    let rich = validate_json(one(
        serde_json::json!({ "id": "r", "type": "ranking", "connection": "end", "config": { "title": "R",
            "rankingItems": ["a", { "text": "b", "image": "x.png" }] } }),
        serde_json::json!([]),
        None,
    ));
    assert!(rich.warnings.is_empty(), "{:?}", rich.warnings);
}

#[test]
fn code_node_without_source_only_warns() {
    let result = validate_json(one(
        serde_json::json!({ "id": "c", "type": "code", "connection": "end", "config": { "title": "C", "source": "  ", "intent": "flash" } }),
        serde_json::json!([]),
        None,
    ));
    assert!(result.valid);
    assert_eq!(codes(&result.warnings), ["code/no-source"]);
}

// ── scene: early exit + nested interactions ─────────────────────────────────

fn scene_with(hotspot: serde_json::Value, extra_config: serde_json::Value, variables: serde_json::Value) -> serde_json::Value {
    let mut config = serde_json::json!({ "title": "S", "environment": { "kind": "photo2d", "source": "x.jpg" }, "hotspots": [hotspot] });
    if let Some(map) = extra_config.as_object() {
        for (k, val) in map {
            config[k] = val.clone();
        }
    }
    one(serde_json::json!({ "id": "s", "type": "scene", "connection": "end", "config": config }), variables, None)
}

#[test]
fn scene_abort_rule_needs_both_halves() {
    let reveal = serde_json::json!({ "id": "h", "label": "H", "position": {}, "reveal": { "kind": "text", "body": "b" } });
    let vars = serde_json::json!([{ "id": "b", "name": "fail", "type": "boolean", "initialValue": false }]);
    let no_var = validate_json(scene_with(reveal.clone(), serde_json::json!({ "abortWhen": { "variableId": "", "targetNodeId": "end" } }), vars.clone()));
    assert_eq!(codes(&no_var.warnings), ["scene/abort-no-variable"]);
    let bad_var = validate_json(scene_with(reveal.clone(), serde_json::json!({ "abortWhen": { "variableId": "ghost", "targetNodeId": "end" } }), vars.clone()));
    assert_eq!(codes(&bad_var.errors), ["scene/abort-bad-variable"]);
    let no_target = validate_json(scene_with(reveal.clone(), serde_json::json!({ "abortWhen": { "variableId": "b" } }), vars.clone()));
    assert_eq!(codes(&no_target.warnings), ["scene/abort-no-target"]);
    let dangling = validate_json(scene_with(reveal, serde_json::json!({ "abortWhen": { "variableId": "b", "targetNodeId": "ghost" } }), vars));
    assert_eq!(codes(&dangling.errors), ["connection/dangling"]);
}

#[test]
fn scene_abort_target_counts_as_an_edge() {
    // The debrief is only reachable through the early exit; it must not be
    // reported unreachable.
    let result = validate_json(serde_json::json!({
        "nodes": [
            { "id": "s", "type": "scene", "config": { "isStart": true, "title": "S", "environment": { "kind": "photo2d", "source": "x.jpg" },
                "hotspots": [ { "id": "h", "label": "H", "position": {}, "reveal": { "kind": "text", "body": "b" } } ],
                "abortWhen": { "variableId": "b", "operator": "is_true", "targetNodeId": "debrief" } } },
            { "id": "debrief", "type": "message", "config": { "title": "D" } }
        ],
        "variables": [ { "id": "b", "name": "fail", "type": "boolean", "initialValue": false } ]
    }));
    assert!(result.valid);
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
}

#[test]
fn interaction_only_hotspot_is_not_inert() {
    let result = validate_json(scene_with(
        serde_json::json!({ "id": "h", "label": "Cream", "position": {}, "interaction": { "type": "multipleChoice",
            "config": { "question": "How much?", "choices": [ { "id": "c1", "text": "Thin" } ] } } }),
        serde_json::json!({}),
        serde_json::json!([]),
    ));
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    let inert = validate_json(scene_with(
        serde_json::json!({ "id": "h", "label": "X", "position": {}, "targetNodeId": "", "reveal": "" }),
        serde_json::json!({}),
        serde_json::json!([]),
    ));
    assert_eq!(codes(&inert.warnings), ["scene/inert-hotspot"]);
}

#[test]
fn unanswerable_nested_interaction_warns() {
    for (itype, config) in [
        ("multipleChoice", serde_json::json!({ "question": "Q", "choices": [] })),
        ("multipleChoice", serde_json::json!({ "question": "Q", "choices": "[]" })),
        ("procedure", serde_json::json!({ "question": "Q" })),
        ("dragToTarget", serde_json::json!({ "question": "Q", "dragTargets": [ { "id": "t", "label": "T" } ] })),
        ("ranking", serde_json::json!({ "question": "Q", "rankingItems": [] })),
        ("matching", serde_json::json!({ "question": "Q" })),
    ] {
        let result = validate_json(scene_with(
            serde_json::json!({ "id": "h", "label": "H", "position": {}, "required": true, "interaction": { "type": itype, "config": config } }),
            serde_json::json!({}),
            serde_json::json!([]),
        ));
        assert_eq!(codes(&result.warnings), ["scene/interaction-unanswerable"], "{itype}");
    }
    // textInput / rating / message need no options.
    for (itype, config) in [
        ("textInput", serde_json::json!({ "question": "Describe it" })),
        ("rating", serde_json::json!({ "question": "Rate" })),
        ("message", serde_json::json!({ "content": "<p>Note</p>" })),
    ] {
        let result = validate_json(scene_with(
            serde_json::json!({ "id": "h", "label": "H", "position": {}, "interaction": { "type": itype, "config": config } }),
            serde_json::json!({}),
            serde_json::json!([]),
        ));
        assert!(result.warnings.is_empty(), "{itype}: {:?}", result.warnings);
    }
}

#[test]
fn nested_question_without_text_warns() {
    for config in [Some(serde_json::json!({})), None] {
        let mut interaction = serde_json::json!({ "type": "textInput" });
        if let Some(config) = config {
            interaction["config"] = config;
        }
        let result = validate_json(scene_with(
            serde_json::json!({ "id": "h", "label": "H", "position": {}, "interaction": interaction }),
            serde_json::json!({}),
            serde_json::json!([]),
        ));
        assert_eq!(codes(&result.warnings), ["scene/interaction-no-question"]);
    }
}

#[test]
fn nested_choice_actions_are_checked() {
    let result = validate_json(scene_with(
        serde_json::json!({ "id": "h", "label": "H", "position": {}, "interaction": { "type": "multipleChoice",
            "config": { "question": "Q", "choices": [ { "id": "c1", "text": "A", "actions": [ { "variableId": "ghost", "operator": "set_true" } ] } ] } } }),
        serde_json::json!({}),
        serde_json::json!([]),
    ));
    assert_eq!(codes(&result.errors), ["action/unknown-variable"]);
}

// ── pass marks must be reachable ────────────────────────────────────────────

fn weighted_module(decision_max: f64, pass_mark: &str) -> serde_json::Value {
    serde_json::json!({
        "nodes": [
            { "id": "talk", "type": "conversation", "connection": "decide", "config": { "isStart": true, "persona": "Margaret", "objective": "Listen", "scoreVariableId": "conv" } },
            { "id": "decide", "type": "choice", "config": { "choices": [
                { "id": "a", "text": "Tell", "connection": "route", "actions": [ { "variableId": "dec", "operator": "set", "value": decision_max } ] },
                { "id": "b", "text": "Wait", "connection": "route", "actions": [ { "variableId": "dec", "operator": "set", "value": decision_max / 2.0 } ] } ] } },
            { "id": "route", "type": "condition", "config": { "criteria": { "criteriaSets": [
                { "id": "pass", "pathLabel": "Pass", "targetNodeId": "end", "conditions": [ { "id": "c1", "field": "total", "operator": ">=", "value": pass_mark } ] } ],
                "defaultTargetNodeId": "end" } } },
            { "id": "end", "type": "message", "config": { "title": "End" } }
        ],
        "variables": [
            { "id": "conv", "name": "conv", "type": "number", "initialValue": 0 },
            { "id": "dec", "name": "dec", "type": "number", "initialValue": 0 },
            { "id": "total", "name": "total", "type": "number", "initialValue": 0, "computed": true, "formula": "conv * 0.6 + dec * 0.4" }
        ]
    })
}

#[test]
fn pass_mark_above_the_ceiling_is_an_error() {
    // conv tops out at 100 (AI score), dec at 40: total can reach 76.
    let result = validate_json(weighted_module(40.0, "80"));
    assert!(!result.valid);
    assert_eq!(codes(&result.errors), ["threshold/unreachable"]);
    assert_eq!(result.errors[0].node_id.as_deref(), Some("route"));
    assert!(result.errors[0].message.contains("most it can ever reach is 76"), "{}", result.errors[0].message);
}

#[test]
fn pass_mark_within_ten_of_the_ceiling_warns() {
    let result = validate_json(weighted_module(40.0, "70"));
    assert!(result.valid);
    assert_eq!(codes(&result.warnings), ["threshold/tight"]);
    let quiet = validate_json(weighted_module(100.0, "70"));
    assert!(quiet.valid);
    assert!(quiet.warnings.is_empty(), "{:?}", quiet.warnings);
}

#[test]
fn incremented_counters_have_no_ceiling() {
    let result = validate_json(one(
        serde_json::json!({ "id": "q", "type": "choice", "config": { "choices": [
            { "id": "a", "text": "x", "connection": "end", "actions": [ { "variableId": "score", "operator": "increment", "value": 10 } ] } ] } }),
        serde_json::json!([{ "id": "score", "name": "score", "type": "number", "initialValue": 0 }]),
        Some(serde_json::json!({ "completion": { "mode": "variable", "variableId": "score", "operator": ">=", "value": 500 } })),
    ));
    assert!(result.valid);
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
}

#[test]
fn module_pass_rule_is_judged_against_set_actions_and_ratings() {
    let set = validate_json(one(
        serde_json::json!({ "id": "q", "type": "choice", "config": { "choices": [
            { "id": "a", "text": "x", "connection": "end", "actions": [ { "variableId": "score", "operator": "set", "value": "50" } ] } ] } }),
        serde_json::json!([{ "id": "score", "name": "score", "type": "number", "initialValue": 0 }]),
        Some(serde_json::json!({ "completion": { "mode": "variable", "variableId": "score", "operator": ">", "value": 60 } })),
    ));
    assert_eq!(codes(&set.errors), ["threshold/unreachable"]);
    // A rating with no ratingMax scores at most 5.
    let rating = validate_json(one(
        serde_json::json!({ "id": "rt", "type": "rating", "connection": "end", "config": { "title": "Rate", "ratingVariableId": "n" } }),
        serde_json::json!([{ "id": "n", "name": "confidence", "type": "number", "initialValue": 0 }]),
        Some(serde_json::json!({ "completion": { "mode": "variable", "variableId": "n", "operator": ">=", "value": 6 } })),
    ));
    assert_eq!(codes(&rating.errors), ["threshold/unreachable"]);
}

// Spec rule 5.3: a namespaced extension type is legal; a bare unknown type
// and a malformed prefix are not. Mirrors the platform's regression test.
fn module_with_type(t: &str) -> serde_json::Value {
    serde_json::json!({
        "nodes": [
            {"id":"start","type":"message","title":"Start","position":{"x":0,"y":0},"color":"#fff",
             "connection":"ext","config":{"title":"Start","isStart":true}},
            {"id":"ext","type":t,"title":"Lab","position":{"x":0,"y":0},"color":"#fff",
             "connection":"end","config":{"anything":true}},
            {"id":"end","type":"message","title":"End","position":{"x":0,"y":0},"color":"#fff","config":{"title":"End"}}
        ]
    })
}

#[test]
fn extension_types_are_accepted_and_bare_unknowns_are_not() {
    let ok = ronu::validate_module(&module_with_type("x-mubs:chemistry-lab"));
    assert!(ok.valid, "extension type must validate: {:?}", ok.errors);
    assert!(!sorted_codes(&ok.errors).iter().any(|c| c == "node/unknown-type"));
    for bad in ["hologram", "x-:lab", "x-mubs"] {
        let r = ronu::validate_module(&module_with_type(bad));
        assert!(sorted_codes(&r.errors).iter().any(|c| c == "node/unknown-type"), "{bad} must be unknown");
    }
}
