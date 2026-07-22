//! The `.ronu` module content model — the single source of truth for the
//! format's shape. Serde drives (de)serialization, `schemars` derives the
//! JSON Schema from these same types, so the schema can never drift from the
//! validator.
//!
//! Reader philosophy (spec: liberal readers, must-ignore): almost every field
//! is optional and unknown fields are captured in a flattened `extra` map
//! rather than rejected, so a file written by a newer writer still parses.
//! `type`/`operator`-style fields are kept as plain strings (not enums) so an
//! unknown value becomes a *validation* issue, never a parse failure.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Unknown/forward-compatible fields, preserved for round-trips.
pub type Extra = BTreeMap<String, Value>;

/// The experience — `module.json`. Matches the platform's `ModuleContent`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct Module {
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub variables: Vec<Variable>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<ModuleSettings>,
    #[serde(flatten, default)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct Point {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

/// A node in the scenario graph. `type` stays a string so unknown node types
/// surface as `node/unknown-type` (validation) instead of a parse error.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct Node {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub node_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Single forward connection for non-branching nodes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<Point>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<NodeConfig>,
    #[serde(flatten, default)]
    pub extra: Extra,
}

/// `config.choices` is either a structured list (choice / multipleChoice) or a
/// JSON-encoded string (legacy condition nodes). Untagged so both forms parse.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Choices {
    Structured(Vec<Choice>),
    /// Legacy: a stringified `ConditionConfig` (see spec §8).
    Encoded(String),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct Choice {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<VariableAction>>,
    #[serde(flatten, default)]
    pub extra: Extra,
}

/// The per-node config bag. Only the fields the skeleton + validator need are
/// typed; everything else (the growing node *catalogue*) rides in `extra`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_start: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,

    // Choice / multipleChoice / (legacy) condition
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choices: Option<Choices>,
    /// Canonical condition criteria (spec §8). Exporters emit this; readers
    /// accept this OR the legacy stringified `choices`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub criteria: Option<ConditionConfig>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triggers: Option<Vec<NodeTrigger>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timer: Option<TimerConfig>,

    // matching
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matching_left_items: Option<Vec<MatchingLeftItem>>,

    // scene
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<SceneEnvironment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotspots: Option<Vec<SceneHotspot>>,
    /// Scene completion mode: `"free"` | `"allRequired"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub miss_actions: Option<Vec<VariableAction>>,

    // conversation
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score_variable_id: Option<String>,

    // rating
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rating_variable_id: Option<String>,

    #[serde(flatten, default)]
    pub extra: Extra,
}

// ─── Variables ──────────────────────────────────────────────────────────────

/// `type` and `initialValue` stay loose (string / arbitrary JSON) so
/// mismatches surface as validation issues, not parse failures.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub var_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
    /// `"module"` (default) | `"learner"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(flatten, default)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VariableAction {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variable_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(flatten, default)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeTrigger {
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub trigger_type: Option<String>,
    #[serde(default)]
    pub actions: Vec<VariableAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
    #[serde(flatten, default)]
    pub extra: Extra,
}

// ─── Timers ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimerConfig {
    /// `"countdown"` | `"countup"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warn_at_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sound: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_expire: Option<TimerExpire>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_variable_id: Option<String>,
    #[serde(flatten, default)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimerExpire {
    /// `"none"` | `"advance"` | `"route"` | `"end"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behavior: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<VariableAction>>,
    #[serde(flatten, default)]
    pub extra: Extra,
}

// ─── Matching ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MatchingLeftItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correct_right_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<VariableAction>>,
    #[serde(flatten, default)]
    pub extra: Extra,
}

// ─── Scene ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct SceneEnvironment {
    /// `"photo360"` | `"photo2d"` | `"splat"` | `"embed3d"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(flatten, default)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SceneHotspot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Anchor — shape varies by environment (yaw/pitch, x/y, or x/y/z).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reveal: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variable_actions: Option<Vec<VariableAction>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<HotspotConversation>,
    #[serde(flatten, default)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HotspotConversation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score_variable_id: Option<String>,
    #[serde(flatten, default)]
    pub extra: Extra,
}

// ─── Condition nodes ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConditionConfig {
    #[serde(default)]
    pub criteria_sets: Vec<CriteriaSet>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_target_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_path_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_real_evaluation: Option<bool>,
    #[serde(flatten, default)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CriteriaSet {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub conditions: Vec<Condition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_label: Option<String>,
    #[serde(flatten, default)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct Condition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// A node id or a variable id — or the literal `"operator"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(flatten, default)]
    pub extra: Extra,
}

// ─── Module settings ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct ModuleSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timer: Option<TimerConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion: Option<CompletionRule>,
    #[serde(flatten, default)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRule {
    /// `"variable"` (default) | `"reachedNode"` | `"nodeScore"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variable_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pass_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score_aggregate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate_validity_months: Option<f64>,
    #[serde(flatten, default)]
    pub extra: Extra,
}
