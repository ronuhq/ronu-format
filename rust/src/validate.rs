//! Semantic validation for `.ronu` module content — a faithful port of the
//! reference TS validator, producing the same issue `code`s.
//!
//! Errors mean the module is broken for learners (dangling connections, no
//! start node, unknown variable references); warnings mean it is legal but
//! suspicious (unreachable nodes, a condition with no default route).

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::Value;

use crate::formula;
use crate::types::{
    Choices, CompletionRule, ConditionConfig, Module, Node, TimerConfig, VariableAction,
};

/// One validation finding. `code` is stable machine-readable identity;
/// `message` is human-facing; `node_id` locates it when relevant.
///
/// Serializes to `{ code, message, nodeId? }` — the exact shape the platform's
/// TS `ValidationIssue` uses, so a JS/wasm consumer is drop-in.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
}

/// Serializes to `{ valid, errors, warnings }` — matches the platform's
/// TS `ValidationResult`.
#[derive(Debug, Clone, Serialize)]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
}

#[derive(Clone)]
struct VarInfo {
    name: Option<String>,
    ty: Option<String>,
    computed: bool,
}

fn normalize_type(t: &str) -> &str {
    match t {
        "router" => "choice",
        "decisionPath" => "condition",
        other => other,
    }
}

const NODE_TYPES: &[&str] = &[
    "message",
    "video",
    "choice",
    "textInput",
    "multipleChoice",
    "ranking",
    "matching",
    "rating",
    "condition",
    "scene",
    "conversation",
    "code",
    "note",
];

fn operators_for_type(ty: &str) -> Option<&'static [&'static str]> {
    match ty {
        "number" => Some(&["set", "increment", "decrement", "multiply", "divide"]),
        "boolean" => Some(&["set", "set_true", "set_false", "toggle"]),
        "text" => Some(&["set"]),
        _ => None,
    }
}

struct Validator {
    errors: Vec<Issue>,
    warnings: Vec<Issue>,
    node_ids: HashSet<String>,
    vars: HashMap<String, VarInfo>,
    edges: HashMap<String, Vec<String>>,
}

impl Validator {
    fn error(&mut self, code: &str, message: impl Into<String>, node_id: Option<&str>) {
        self.errors.push(Issue {
            code: code.to_string(),
            message: message.into(),
            node_id: node_id.map(str::to_string),
        });
    }
    fn warn(&mut self, code: &str, message: impl Into<String>, node_id: Option<&str>) {
        self.warnings.push(Issue {
            code: code.to_string(),
            message: message.into(),
            node_id: node_id.map(str::to_string),
        });
    }

    /// Owned copy of a variable's info, so callers can look up and then push
    /// issues without holding a borrow on `self.vars`.
    fn lookup(&self, id: &str) -> Option<VarInfo> {
        self.vars.get(id).cloned()
    }

    fn add_edge(&mut self, from: &str, to: Option<&str>) {
        if let Some(t) = to {
            if !t.is_empty() {
                self.edges.entry(from.to_string()).or_default().push(t.to_string());
            }
        }
    }

    fn check_connection(&mut self, from: &Node, target: Option<&str>, what: &str) {
        if let Some(t) = target {
            if !t.is_empty() && !self.node_ids.contains(t) {
                let label = node_label(from);
                self.error(
                    "connection/dangling",
                    format!("{what} on node \"{label}\" points at nonexistent node \"{t}\""),
                    from.id.as_deref(),
                );
            }
        }
    }

    fn check_actions(&mut self, from: &Node, actions: Option<&Vec<VariableAction>>, what: &str) {
        let Some(actions) = actions else { return };
        let label = node_label(from);
        for action in actions {
            let Some(vid) = action.variable_id.as_deref().filter(|s| !s.is_empty()) else {
                continue;
            };
            match self.lookup(vid) {
                None => self.error(
                    "action/unknown-variable",
                    format!("{what} on node \"{label}\" targets a nonexistent variable"),
                    from.id.as_deref(),
                ),
                Some(var) => {
                    if var.computed {
                        let vname = var.name.clone().unwrap_or_default();
                        self.error(
                            "action/computed-target",
                            format!("{what} on node \"{label}\" targets computed variable \"{vname}\" — computed variables are read-only"),
                            from.id.as_deref(),
                        );
                    }
                    if let (Some(ty), Some(op)) = (var.ty.as_deref(), action.operator.as_deref()) {
                        if let Some(legal) = operators_for_type(ty) {
                            if !legal.contains(&op) {
                                let vname = var.name.clone().unwrap_or_default();
                                self.error(
                                    "action/bad-operator",
                                    format!("{what} on node \"{label}\" uses operator \"{op}\" on {ty} variable \"{vname}\""),
                                    from.id.as_deref(),
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    /// A number-variable target used by timers/ratings: must exist, be
    /// non-computed, and be a number.
    fn check_number_target(
        &mut self,
        code: &str,
        variable_id: Option<&str>,
        ctx: &str,
        node_id: Option<&str>,
    ) {
        let Some(vid) = variable_id.filter(|s| !s.is_empty()) else { return };
        match self.lookup(vid) {
            None => self.error(&format!("{code}-unknown"), format!("{ctx} targets a nonexistent variable"), node_id),
            Some(var) => {
                if var.computed || var.ty.as_deref() != Some("number") {
                    self.error(&format!("{code}-bad"), format!("{ctx} must use a non-computed number variable"), node_id);
                }
            }
        }
    }

    fn check_timer(
        &mut self,
        timer: Option<&TimerConfig>,
        ctx: &str,
        node_id: Option<&str>,
        scope: Scope,
    ) {
        let Some(timer) = timer else { return };
        let mode = timer.mode.as_deref();
        if mode != Some("countdown") && mode != Some("countup") {
            self.error("timer/bad-mode", format!("{ctx} timer has an invalid mode"), node_id);
            return;
        }
        if mode == Some("countdown") {
            match timer.seconds {
                Some(s) if s > 0.0 => {}
                _ => self.error("timer/no-seconds", format!("{ctx} countdown timer needs a positive time limit"), node_id),
            }
            if let (Some(warn_at), Some(seconds)) = (timer.warn_at_seconds, timer.seconds) {
                if seconds > 0.0 && warn_at >= seconds {
                    self.warn(
                        "timer/warn-at-too-high",
                        format!("{ctx} timer turns red at {warn_at}s left, at or above its {seconds}s limit — it will start red."),
                        node_id,
                    );
                }
            }
            let behavior = timer.on_expire.as_ref().and_then(|e| e.behavior.as_deref());
            if behavior == Some("route") {
                let target = timer.on_expire.as_ref().and_then(|e| e.target_node_id.as_deref());
                match target {
                    None => self.warn("timer/route-no-target", format!("{ctx} timer routes when time runs out, but no destination is set"), node_id),
                    Some(t) if !self.node_ids.contains(t) => {
                        self.error("timer/route-dangling", format!("{ctx} timer routes on expiry to a node that doesn't exist"), node_id)
                    }
                    _ => {}
                }
            }
            if scope == Scope::Module && behavior == Some("advance") {
                self.warn("timer/module-advance", "The module timer can't \"go to the next node\" — use route to a specific node or end the module instead", node_id);
            }
            if let Some(expire) = &timer.on_expire {
                if let Some(actions) = &expire.actions {
                    for action in actions {
                        let Some(vid) = action.variable_id.as_deref().filter(|s| !s.is_empty()) else { continue };
                        match self.lookup(vid) {
                            None => self.error("timer/action-unknown-variable", format!("{ctx} timer's expiry action targets a nonexistent variable"), node_id),
                            Some(var) if var.computed => {
                                let vname = var.name.clone().unwrap_or_default();
                                self.error("timer/action-computed", format!("{ctx} timer's expiry action targets computed variable \"{vname}\" (read-only)"), node_id);
                            }
                            _ => {}
                        }
                    }
                }
            }
        } else {
            // count-up
            let behavior = timer.on_expire.as_ref().and_then(|e| e.behavior.as_deref());
            if let Some(b) = behavior {
                if b != "none" {
                    self.warn("timer/countup-onexpire", format!("{ctx} is a count-up (stopwatch) timer, so its \"when time runs out\" action is ignored"), node_id);
                }
            }
        }
        self.check_number_target("timer/record", timer.record_variable_id.as_deref(), &format!("{ctx} timer's \"record elapsed time\" variable"), node_id);
    }

    fn check_completion(&mut self, rule: Option<&CompletionRule>) {
        let Some(rule) = rule else { return };
        let mode = rule.mode.as_deref().unwrap_or("variable");
        if mode == "reachedNode" {
            match rule.pass_node_id.as_deref() {
                None => self.warn("completion/no-node", "The module's pass rule has no target node selected", None),
                Some(n) if !self.node_ids.contains(n) => {
                    self.error("completion/dangling-node", "The module's pass rule requires reaching a node that doesn't exist", None)
                }
                _ => {}
            }
            return;
        }
        if mode == "nodeScore" {
            if let Some(n) = rule.score_node_id.as_deref() {
                if !self.node_ids.contains(n) {
                    self.error("completion/dangling-node", "The module's pass rule grades a node that doesn't exist", None);
                }
            }
            if rule.operator.is_none() {
                self.warn("completion/no-operator", "The module's score pass rule has no comparison set", None);
            }
            return;
        }
        // variable mode
        let Some(vid) = rule.variable_id.as_deref() else {
            self.warn("completion/no-variable", "The module's pass rule has no variable selected", None);
            return;
        };
        let Some(var) = self.lookup(vid) else {
            self.error("completion/unknown-variable", "The module's pass rule references a variable that doesn't exist", None);
            return;
        };
        let vname = var.name.clone().unwrap_or_default();
        let vty = var.ty.clone();
        let Some(op) = rule.operator.as_deref() else {
            self.warn("completion/no-operator", format!("The module's pass rule on \"{vname}\" has no comparison set"), None);
            return;
        };
        let numeric_ops = ["<", ">", "<=", ">="];
        let bool_ops = ["is_true", "is_false"];
        if numeric_ops.contains(&op) && vty.as_deref() != Some("number") {
            self.error("completion/op-type", format!("The module's pass rule uses a numeric comparison on non-number variable \"{vname}\""), None);
        } else if bool_ops.contains(&op) && vty.as_deref() != Some("boolean") {
            self.error("completion/op-type", format!("The module's pass rule uses true/false on non-boolean variable \"{vname}\""), None);
        } else if op == "contains" && vty.as_deref() != Some("text") {
            self.error("completion/op-type", format!("The module's pass rule uses \"contains\" on non-text variable \"{vname}\""), None);
        }
    }
}

#[derive(PartialEq, Clone, Copy)]
enum Scope {
    Node,
    Module,
}

fn node_label(node: &Node) -> String {
    node.config
        .as_ref()
        .and_then(|c| c.title.clone())
        .or_else(|| node.id.clone())
        .unwrap_or_else(|| "?".to_string())
}

/// Parse a condition node's criteria (canonical object at `config.criteria`, or
/// legacy JSON-encoded string at `config.choices`). Returns `None` when the
/// node has neither, or the legacy string doesn't parse.
fn parse_condition_config(node: &Node) -> Option<ConditionConfig> {
    let config = node.config.as_ref()?;
    if let Some(criteria) = &config.criteria {
        return Some(criteria.clone());
    }
    if let Some(Choices::Encoded(s)) = &config.choices {
        return serde_json::from_str::<ConditionConfig>(s).ok();
    }
    None
}

/// Validate raw module content. Mirrors the reference `validateModuleContent`.
pub fn validate_module(content: &Value) -> ValidationResult {
    let mut v = Validator {
        errors: Vec::new(),
        warnings: Vec::new(),
        node_ids: HashSet::new(),
        vars: HashMap::new(),
        edges: HashMap::new(),
    };

    // ── Shape ────────────────────────────────────────────────────────────
    if !content.is_object() {
        v.error("content/invalid", "Module content must be an object", None);
        return ValidationResult { valid: false, errors: v.errors, warnings: v.warnings };
    }
    if !content.get("nodes").map(Value::is_array).unwrap_or(false) {
        v.error("nodes/missing", "Module content must contain a nodes array", None);
        return ValidationResult { valid: false, errors: v.errors, warnings: v.warnings };
    }

    // Liberal-parse into the typed model (unknown fields captured, never fatal).
    let module: Module = match serde_json::from_value(content.clone()) {
        Ok(m) => m,
        Err(e) => {
            v.error("content/unparseable", format!("Module content could not be read: {e}"), None);
            return ValidationResult { valid: false, errors: v.errors, warnings: v.warnings };
        }
    };

    // ── Variables ────────────────────────────────────────────────────────
    let mut non_computed_names: HashSet<String> = HashSet::new();
    let mut seen_names: HashSet<String> = HashSet::new();
    for var in &module.variables {
        match var.name.as_deref().map(str::trim) {
            None | Some("") => v.error("variable/no-name", format!("Variable {} has no name", var.id.as_deref().unwrap_or("?")), None),
            Some(name) => {
                if seen_names.contains(name) {
                    v.error("variable/duplicate-name", format!("Duplicate variable name \"{name}\""), None);
                } else {
                    seen_names.insert(name.to_string());
                }
            }
        }
        if var.id.is_none() {
            v.error("variable/no-id", format!("Variable \"{}\" has no id", var.name.as_deref().unwrap_or("?")), None);
        }
        let ty = var.var_type.as_deref();
        if !matches!(ty, Some("number") | Some("boolean") | Some("text")) {
            v.error("variable/bad-type", format!("Variable \"{}\" has unknown type \"{}\"", var.name.as_deref().unwrap_or(""), ty.unwrap_or("")), None);
        }
        if var.computed.unwrap_or(false) {
            if ty != Some("number") {
                v.error("variable/computed-not-number", format!("Computed variable \"{}\" must be a number", var.name.as_deref().unwrap_or("")), None);
            }
            if var.formula.as_deref().map(str::trim).unwrap_or("").is_empty() {
                v.error("variable/computed-no-formula", format!("Computed variable \"{}\" has no formula", var.name.as_deref().unwrap_or("")), None);
            }
        } else {
            if ty == Some("number") && !var.initial_value.as_ref().map(Value::is_number).unwrap_or(false) {
                v.error("variable/initial-mismatch", format!("Variable \"{}\" is a number but its initial value isn't", var.name.as_deref().unwrap_or("")), None);
            }
            if ty == Some("boolean") && !var.initial_value.as_ref().map(Value::is_boolean).unwrap_or(false) {
                v.error("variable/initial-mismatch", format!("Variable \"{}\" is a boolean but its initial value isn't", var.name.as_deref().unwrap_or("")), None);
            }
            if let Some(name) = var.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                non_computed_names.insert(name.to_string());
            }
        }
        if let Some(id) = var.id.clone() {
            v.vars.insert(id, VarInfo { name: var.name.clone(), ty: var.var_type.clone(), computed: var.computed.unwrap_or(false) });
        }
    }
    // Computed formulas parse and reference only non-computed variables.
    for var in &module.variables {
        if !var.computed.unwrap_or(false) {
            continue;
        }
        let Some(fstr) = var.formula.as_deref().filter(|s| !s.trim().is_empty()) else { continue };
        match formula::identifiers(fstr) {
            Ok(ids) => {
                for name in ids {
                    if !non_computed_names.contains(&name) {
                        v.error("variable/formula-unknown-ref", format!("Computed variable \"{}\" references \"{name}\", which is not a non-computed variable", var.name.as_deref().unwrap_or("")), None);
                    }
                }
            }
            Err(e) => v.error("variable/formula-invalid", format!("Computed variable \"{}\" has an invalid formula: {e}", var.name.as_deref().unwrap_or("")), None),
        }
    }

    // ── Nodes: ids, types, start node ────────────────────────────────────
    let mut start_count = 0;
    for node in &module.nodes {
        let Some(id) = node.id.clone().filter(|s| !s.is_empty()) else {
            v.error("node/no-id", format!("A {} node has no id", node.node_type.as_deref().unwrap_or("?")), None);
            continue;
        };
        if v.node_ids.contains(&id) {
            v.error("node/duplicate-id", format!("Duplicate node id \"{id}\""), Some(&id));
        }
        v.node_ids.insert(id.clone());
        let raw_type = node.node_type.as_deref().unwrap_or("");
        if !NODE_TYPES.contains(&normalize_type(raw_type)) {
            v.error("node/unknown-type", format!("Node \"{id}\" has unknown type \"{raw_type}\""), Some(&id));
        }
        if node.config.as_ref().and_then(|c| c.is_start).unwrap_or(false) {
            start_count += 1;
        }
    }
    if !module.nodes.is_empty() && start_count == 0 {
        v.error("module/no-start", "Module has no start node", None);
    }
    if start_count > 1 {
        v.error("module/multiple-starts", format!("Module has {start_count} start nodes — there must be exactly one"), None);
    }

    // ── Per-node checks + edges ──────────────────────────────────────────
    for node in &module.nodes {
        let Some(id) = node.id.clone().filter(|s| !s.is_empty()) else { continue };
        let raw_type = node.node_type.as_deref().unwrap_or("");
        let ntype = normalize_type(raw_type);
        let cfg = node.config.as_ref();

        v.check_connection(node, node.connection.as_deref(), "Connection");
        v.add_edge(&id, node.connection.as_deref());

        if let Some(cfg) = cfg {
            for trigger in cfg.triggers.iter().flatten() {
                let what = format!("Trigger \"{}\"", trigger.trigger_type.as_deref().unwrap_or(""));
                v.check_actions(node, Some(&trigger.actions), &what);
            }
            // node/scene timer (config.timer)
            let label = node_label(node);
            v.check_timer(cfg.timer.as_ref(), &format!("Node \"{label}\""), Some(&id), Scope::Node);
            if cfg.timer.as_ref().and_then(|t| t.mode.as_deref()) == Some("countdown")
                && cfg.timer.as_ref().and_then(|t| t.on_expire.as_ref()).and_then(|e| e.behavior.as_deref()) == Some("route")
            {
                let target = cfg.timer.as_ref().and_then(|t| t.on_expire.as_ref()).and_then(|e| e.target_node_id.clone());
                v.add_edge(&id, target.as_deref());
            }
        }

        if ntype == "choice" || ntype == "multipleChoice" {
            let choices: &[crate::types::Choice] = match cfg.and_then(|c| c.choices.as_ref()) {
                Some(Choices::Structured(list)) => list,
                _ => &[],
            };
            for choice in choices {
                if ntype == "choice" {
                    let what = format!("Choice \"{}\"", choice.text.as_deref().or(choice.id.as_deref()).unwrap_or(""));
                    v.check_connection(node, choice.connection.as_deref(), &what);
                    v.add_edge(&id, choice.connection.as_deref());
                }
                let what = format!("Choice \"{}\"", choice.text.as_deref().or(choice.id.as_deref()).unwrap_or(""));
                v.check_actions(node, choice.actions.as_ref(), &what);
            }
            if ntype == "choice" && choices.is_empty() {
                let label = node_label(node);
                v.warn("choice/empty", format!("Choice node \"{label}\" has no choices"), Some(&id));
            }
        }

        if ntype == "matching" {
            for item in cfg.and_then(|c| c.matching_left_items.as_ref()).into_iter().flatten() {
                v.check_actions(node, item.actions.as_ref(), "Matching item");
            }
        }

        if ntype == "scene" {
            let title = node_label(node);
            if cfg.and_then(|c| c.environment.as_ref()).and_then(|e| e.source.as_deref()).map(str::is_empty).unwrap_or(true) {
                v.warn("scene/no-environment", format!("Scene node \"{title}\" has no environment image yet"), Some(&id));
            }
            let mut required_count = 0;
            let completion = cfg.and_then(|c| c.completion.as_deref());
            for hotspot in cfg.and_then(|c| c.hotspots.as_ref()).into_iter().flatten() {
                if hotspot.required.unwrap_or(false) {
                    required_count += 1;
                }
                let hlabel = hotspot.label.as_deref().or(hotspot.id.as_deref()).unwrap_or("").to_string();
                v.check_connection(node, hotspot.target_node_id.as_deref(), &format!("Hotspot \"{hlabel}\""));
                v.add_edge(&id, hotspot.target_node_id.as_deref());
                v.check_actions(node, hotspot.variable_actions.as_ref(), &format!("Hotspot \"{hlabel}\""));
                let inert = hotspot.reveal.is_none()
                    && hotspot.target_node_id.is_none()
                    && hotspot.variable_actions.as_ref().map(|a| a.is_empty()).unwrap_or(true)
                    && hotspot.conversation.is_none();
                if inert {
                    v.warn("scene/inert-hotspot", format!("Hotspot \"{hlabel}\" on scene \"{title}\" does nothing — give it a reveal, a route, a conversation, or variable actions"), Some(&id));
                }
                if hotspot.required.unwrap_or(false) && hotspot.target_node_id.is_some() && completion == Some("allRequired") {
                    v.warn("scene/required-hotspot-routes-away", format!("Hotspot \"{hlabel}\" on scene \"{title}\" is required AND routes away — learners can never find the other required hotspots."), Some(&id));
                }
                if let Some(conv) = &hotspot.conversation {
                    if conv.persona.as_deref().map(str::trim).unwrap_or("").is_empty() {
                        v.warn("scene/character-no-persona", format!("Character hotspot \"{hlabel}\" on scene \"{title}\" has no persona yet"), Some(&id));
                    }
                    if let Some(svid) = conv.score_variable_id.as_deref() {
                        match v.lookup(svid) {
                            None => v.error("scene/character-unknown-variable", format!("Character hotspot \"{hlabel}\" on scene \"{title}\" scores into a nonexistent variable"), Some(&id)),
                            Some(var) if var.computed || var.ty.as_deref() != Some("number") => {
                                v.error("scene/character-bad-variable", format!("Character hotspot \"{hlabel}\" on scene \"{title}\" must score into a non-computed number variable"), Some(&id))
                            }
                            _ => {}
                        }
                    }
                }
            }
            v.check_actions(node, cfg.and_then(|c| c.miss_actions.as_ref()), "Wrong-guess actions");
            if completion == Some("allRequired") && required_count == 0 {
                v.error("scene/no-required-hotspots", format!("Scene \"{title}\" requires all hotspots to be visited, but none are marked required"), Some(&id));
            }
        }

        if ntype == "conversation" {
            let title = node_label(node);
            if cfg.and_then(|c| c.persona.as_deref()).map(str::trim).unwrap_or("").is_empty() {
                v.warn("conversation/no-persona", format!("Conversation node \"{title}\" has no character persona yet"), Some(&id));
            }
            if cfg.and_then(|c| c.objective.as_deref()).map(str::trim).unwrap_or("").is_empty() {
                v.warn("conversation/no-objective", format!("Conversation node \"{title}\" has no objective — the AI can't assess the learner without one"), Some(&id));
            }
            if let Some(svid) = cfg.and_then(|c| c.score_variable_id.as_deref()) {
                match v.lookup(svid) {
                    None => v.error("conversation/unknown-variable", format!("Conversation node \"{title}\" scores into a nonexistent variable"), Some(&id)),
                    Some(var) if var.computed => v.error("conversation/computed-target", format!("Conversation node \"{title}\" scores into a computed variable"), Some(&id)),
                    Some(var) if var.ty.as_deref() != Some("number") => v.error("conversation/non-number", format!("Conversation node \"{title}\" scores into a non-number variable"), Some(&id)),
                    _ => {}
                }
            }
        }

        if ntype == "rating" {
            if let Some(rvid) = cfg.and_then(|c| c.rating_variable_id.as_deref()) {
                let title = node_label(node);
                match v.lookup(rvid) {
                    None => v.error("rating/unknown-variable", format!("Rating node \"{title}\" stores into a nonexistent variable"), Some(&id)),
                    Some(var) if var.computed => v.error("rating/computed-target", format!("Rating node \"{title}\" stores into a computed variable"), Some(&id)),
                    Some(var) if var.ty.as_deref() != Some("number") => v.error("rating/non-number", format!("Rating node \"{title}\" stores into a non-number variable"), Some(&id)),
                    _ => {}
                }
            }
        }

        if ntype == "condition" {
            let title = node_label(node);
            match parse_condition_config(node) {
                None => {
                    v.error("condition/unparseable", format!("Condition node \"{title}\" has missing or invalid criteria configuration"), Some(&id));
                    continue;
                }
                Some(config) => {
                    for set in &config.criteria_sets {
                        v.check_connection(node, set.target_node_id.as_deref(), "Condition target");
                        v.add_edge(&id, set.target_node_id.as_deref());
                        for condition in &set.conditions {
                            let Some(field) = condition.field.as_deref() else { continue };
                            if field == "operator" {
                                continue;
                            }
                            if !field.is_empty() && !v.node_ids.contains(field) && !v.vars.contains_key(field) {
                                v.error("condition/unknown-ref", format!("Condition on node \"{title}\" references \"{field}\", which is neither a node nor a variable"), Some(&id));
                            }
                        }
                    }
                    let default_target = config.default_target_node_id.as_deref().filter(|s| !s.is_empty());
                    v.check_connection(node, default_target, "Condition default target");
                    v.add_edge(&id, default_target);
                    if default_target.is_none() {
                        v.warn("condition/no-default", format!("Condition node \"{title}\" has no default target — learners whose answers match no criteria set will dead-end"), Some(&id));
                    }
                    if config.use_real_evaluation == Some(false) {
                        v.warn("condition/manual-mode", format!("Condition node \"{title}\" is in manual-selection mode (useRealEvaluation: false) — usually a leftover test setting"), Some(&id));
                    }
                }
            }
        }
    }

    // ── Module-level settings ────────────────────────────────────────────
    v.check_timer(module.settings.as_ref().and_then(|s| s.timer.as_ref()), "The module", None, Scope::Module);
    v.check_completion(module.settings.as_ref().and_then(|s| s.completion.as_ref()));

    // ── Placeholders reference defined variables ─────────────────────────
    let all_names: HashSet<String> = module
        .variables
        .iter()
        .filter_map(|v| v.name.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string))
        .collect();
    for node in &module.nodes {
        let Some(id) = node.id.as_deref().filter(|s| !s.is_empty()) else { continue };
        if normalize_type(node.node_type.as_deref().unwrap_or("")) == "condition" {
            continue;
        }
        if let Some(cfg) = &node.config {
            let as_value = serde_json::to_value(cfg).unwrap_or(Value::Null);
            scan_strings(&as_value, id, &all_names, &mut v);
        }
    }

    // ── Reachability from the start node ─────────────────────────────────
    let start = module
        .nodes
        .iter()
        .find(|n| n.config.as_ref().and_then(|c| c.is_start).unwrap_or(false))
        .or_else(|| module.nodes.first());
    if let Some(start) = start {
        if let Some(start_id) = start.id.as_deref().filter(|s| !s.is_empty()) {
            let mut reachable: HashSet<String> = HashSet::new();
            reachable.insert(start_id.to_string());
            let mut queue = vec![start_id.to_string()];
            while let Some(current) = queue.pop() {
                if let Some(nexts) = v.edges.get(&current).cloned() {
                    for next in nexts {
                        if v.node_ids.contains(&next) && !reachable.contains(&next) {
                            reachable.insert(next.clone());
                            queue.push(next);
                        }
                    }
                }
            }
            for node in &module.nodes {
                if normalize_type(node.node_type.as_deref().unwrap_or("")) == "note" {
                    continue;
                }
                if let Some(nid) = node.id.as_deref().filter(|s| !s.is_empty()) {
                    if !reachable.contains(nid) {
                        let label = node_label(node);
                        v.warn("node/unreachable", format!("Node \"{label}\" cannot be reached from the start node"), Some(nid));
                    }
                }
            }
        }
    }

    ValidationResult {
        valid: v.errors.is_empty(),
        errors: v.errors,
        warnings: v.warnings,
    }
}

/// Recursively scan a config subtree for `{placeholder}` tokens that don't name
/// a defined variable.
fn scan_strings(value: &Value, node_id: &str, all_names: &HashSet<String>, v: &mut Validator) {
    match value {
        Value::String(s) => {
            let bytes = s.as_bytes();
            let mut i = 0;
            while i < bytes.len() {
                if bytes[i] == b'{' {
                    let mut j = i + 1;
                    while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
                        j += 1;
                    }
                    if j < bytes.len() && bytes[j] == b'}' && j > i + 1 {
                        let name = &s[i + 1..j];
                        if !all_names.contains(name) {
                            v.warn("placeholder/unknown", format!("Node \"{node_id}\" uses {{{name}}}, which is not a defined variable"), Some(node_id));
                        }
                        i = j + 1;
                        continue;
                    }
                }
                i += 1;
            }
        }
        Value::Array(arr) => {
            for item in arr {
                scan_strings(item, node_id, all_names, v);
            }
        }
        Value::Object(map) => {
            for item in map.values() {
                scan_strings(item, node_id, all_names, v);
            }
        }
        _ => {}
    }
}
