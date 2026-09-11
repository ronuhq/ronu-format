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

/// Spec rule 5.3: `x-<namespace>:<type>` is a legal extension node type
/// that a player treats as known but opaque (rule 5.2 fallback). The
/// validator accepts it rather than rejecting the module. Mirrors the
/// platform's EXTENSION_TYPE_PATTERN exactly.
fn is_extension_type(t: &str) -> bool {
    let Some(rest) = t.strip_prefix("x-") else { return false };
    let Some((ns, name)) = rest.split_once(':') else { return false };
    let ns_ok = !ns.is_empty()
        && ns.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    let name_ok = !name.is_empty()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-');
    ns_ok && name_ok
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
    // Assessed by doing rather than describing. Perform a task in order; a
    // wrong step lands immediately.
    "procedure",
    // Put the right thing in the right place.
    "dragToTarget",
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
                            format!("{what} on node \"{label}\" targets computed variable \"{vname}\": computed variables are read-only"),
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
                        format!("{ctx} timer turns red at {warn_at}s left, which is at or above its {seconds}s limit. It will start red. Set the warning lower."),
                        node_id,
                    );
                }
            }
            let behavior = timer.on_expire.as_ref().and_then(|e| e.behavior.as_deref());
            if behavior == Some("route") {
                let target = timer.on_expire.as_ref().and_then(|e| e.target_node_id.as_deref()).filter(|s| !s.is_empty());
                match target {
                    None => self.warn("timer/route-no-target", format!("{ctx} timer routes when time runs out, but no destination is set"), node_id),
                    Some(t) if !self.node_ids.contains(t) => {
                        self.error("timer/route-dangling", format!("{ctx} timer routes on expiry to a node that doesn't exist"), node_id)
                    }
                    _ => {}
                }
            }
            if scope == Scope::Module && behavior == Some("advance") {
                self.warn("timer/module-advance", "The module timer can't \"go to the next node\". Use route to a specific node or end the module instead", node_id);
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
        // Empty strings are "unset" throughout, as in the reference (`!x`).
        let mode = rule.mode.as_deref().filter(|s| !s.is_empty()).unwrap_or("variable");
        if mode == "reachedNode" {
            match rule.pass_node_id.as_deref().filter(|s| !s.is_empty()) {
                None => self.warn("completion/no-node", "The module's pass rule has no target node selected", None),
                Some(n) if !self.node_ids.contains(n) => {
                    self.error("completion/dangling-node", "The module's pass rule requires reaching a node that doesn't exist", None)
                }
                _ => {}
            }
            return;
        }
        if mode == "nodeScore" {
            if let Some(n) = rule.score_node_id.as_deref().filter(|s| !s.is_empty()) {
                if !self.node_ids.contains(n) {
                    self.error("completion/dangling-node", "The module's pass rule grades a node that doesn't exist", None);
                }
            }
            if rule.operator.as_deref().unwrap_or("").is_empty() {
                self.warn("completion/no-operator", "The module's score pass rule has no comparison set", None);
            }
            return;
        }
        // variable mode
        let Some(vid) = rule.variable_id.as_deref().filter(|s| !s.is_empty()) else {
            self.warn("completion/no-variable", "The module's pass rule has no variable selected", None);
            return;
        };
        let Some(var) = self.lookup(vid) else {
            self.error("completion/unknown-variable", "The module's pass rule references a variable that doesn't exist", None);
            return;
        };
        let vname = var.name.clone().unwrap_or_default();
        let vty = var.ty.clone();
        let Some(op) = rule.operator.as_deref().filter(|s| !s.is_empty()) else {
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
        if var.id.as_deref().unwrap_or("").is_empty() {
            v.error("variable/no-id", format!("Variable \"{}\" has no id", var.name.as_deref().filter(|s| !s.is_empty()).unwrap_or("?")), None);
        }
        match var.name.as_deref().map(str::trim) {
            None | Some("") => v.error("variable/no-name", format!("Variable {} has no name", var.id.as_deref().filter(|s| !s.is_empty()).unwrap_or("?")), None),
            Some(name) => {
                if seen_names.contains(name) {
                    v.error("variable/duplicate-name", format!("Duplicate variable name \"{name}\""), None);
                } else {
                    seen_names.insert(name.to_string());
                }
            }
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
        if let Some(id) = var.id.clone().filter(|s| !s.is_empty()) {
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
        if !NODE_TYPES.contains(&normalize_type(raw_type)) && !is_extension_type(raw_type) {
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
        v.error("module/multiple-starts", format!("Module has {start_count} start nodes. There must be exactly one"), None);
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

        if ntype == "procedure" {
            let title = node_label(node);
            let steps: &[crate::types::ProcedureStep] =
                cfg.and_then(|c| c.procedure_steps.as_deref()).unwrap_or(&[]);
            if steps.is_empty() {
                v.warn("procedure/no-steps", format!("Procedure \"{title}\" has no steps, so there is nothing to perform"), Some(&id));
            }
            for step in steps {
                let text = step.text.as_deref().filter(|s| !s.is_empty());
                v.check_actions(node, step.early_actions.as_ref(), &format!("Procedure step \"{}\"", text.unwrap_or("?")));
                // A step marked critical with no explanation tells the learner
                // they got it wrong without telling them why, which is the whole
                // point of doing it in order rather than scoring at the end.
                if step.critical.unwrap_or(false) && step.if_early.as_deref().map(str::trim).unwrap_or("").is_empty() {
                    v.warn(
                        "procedure/critical-no-reason",
                        format!("Procedure \"{title}\" marks \"{}\" critical but says nothing about what goes wrong if it is taken early", text.unwrap_or("a step")),
                        Some(&id),
                    );
                }
            }
        }

        if ntype == "dragToTarget" {
            let title = node_label(node);
            let targets: &[crate::types::DragTarget] = cfg.and_then(|c| c.drag_targets.as_deref()).unwrap_or(&[]);
            let items: &[crate::types::DragItem] = cfg.and_then(|c| c.drag_items.as_deref()).unwrap_or(&[]);
            if targets.is_empty() || items.is_empty() {
                v.warn(
                    "dragToTarget/incomplete",
                    format!("\"{title}\" needs both places and things: it has {} place(s) and {} thing(s)", targets.len(), items.len()),
                    Some(&id),
                );
            }
            let target_ids: HashSet<&str> = targets.iter().filter_map(|t| t.id.as_deref()).collect();
            for item in items {
                // An item pointing at a deleted place can never be placed
                // correctly, and reads to the creator as a distractor they did
                // not author.
                if let Some(tid) = item.target_id.as_deref().filter(|s| !s.is_empty()) {
                    if !target_ids.contains(tid) {
                        let ilabel = item.label.as_deref().filter(|s| !s.is_empty()).or(item.id.as_deref()).unwrap_or("");
                        v.warn("dragToTarget/orphan-item", format!("\"{title}\": \"{ilabel}\" belongs to a place that no longer exists"), Some(&id));
                    }
                }
            }
        }

        if ntype == "matching" {
            let title = node_label(node);
            let left: &[crate::types::MatchingLeftItem] = cfg.and_then(|c| c.matching_left_items.as_deref()).unwrap_or(&[]);
            let right: &[crate::types::MatchingRightItem] = cfg.and_then(|c| c.matching_right_items.as_deref()).unwrap_or(&[]);
            let right_ids: HashSet<&str> = right.iter().filter_map(|r| r.id.as_deref()).filter(|s| !s.is_empty()).collect();
            if left.is_empty() || right.is_empty() {
                v.warn("matching/empty", format!("Matching node \"{title}\" has no left or right items yet"), Some(&id));
            }
            for item in left {
                v.check_actions(node, item.actions.as_ref(), "Matching item");
                if let Some(rid) = item.correct_right_id.as_deref().filter(|s| !s.is_empty()) {
                    if !right_ids.contains(rid) {
                        let ilabel = item.text.as_deref().filter(|s| !s.is_empty()).or(item.id.as_deref()).unwrap_or("");
                        v.error("matching/dangling-match", format!("Matching item \"{ilabel}\" on node \"{title}\" is matched to a right item that doesn't exist"), Some(&id));
                    }
                }
            }
        }

        if ntype == "ranking" {
            let count = cfg.and_then(|c| c.ranking_items.as_ref()).map(Vec::len).unwrap_or(0);
            if count < 2 {
                let title = node_label(node);
                v.warn("ranking/too-few", format!("Ranking node \"{title}\" needs at least 2 items to put in order"), Some(&id));
            }
        }

        if ntype == "code" && cfg.and_then(|c| c.source.as_deref()).map(str::trim).unwrap_or("").is_empty() {
            // Empty source is the intended copilot output (the code generator
            // fills it later): surface it, but don't block the module.
            let title = node_label(node);
            v.warn("code/no-source", format!("Code node \"{title}\" has no behaviour written yet"), Some(&id));
        }

        if ntype == "scene" {
            let title = node_label(node);
            if cfg.and_then(|c| c.environment.as_ref()).and_then(|e| e.source.as_deref()).map(str::is_empty).unwrap_or(true) {
                v.warn("scene/no-environment", format!("Scene node \"{title}\" has no environment image yet"), Some(&id));
            }
            // Critical-failure exit. A half-authored rule is worse than none
            // (it either never fires or ejects the learner to nowhere), so both
            // halves are checked, and the target goes through the same
            // connection check as any other edge.
            if let Some(abort) = cfg.and_then(|c| c.abort_when.as_ref()) {
                match abort.variable_id.as_deref().filter(|s| !s.is_empty()) {
                    None => v.warn("scene/abort-no-variable", format!("Scene \"{title}\" has an early-exit rule with no variable chosen. It will never fire"), Some(&id)),
                    Some(vid) if !v.vars.contains_key(vid) => {
                        v.error("scene/abort-bad-variable", format!("Scene \"{title}\"'s early-exit rule points at a variable that no longer exists"), Some(&id))
                    }
                    _ => {}
                }
                match abort.target_node_id.as_deref().filter(|s| !s.is_empty()) {
                    None => v.warn("scene/abort-no-target", format!("Scene \"{title}\" has an early-exit rule with no node to go to. It will never fire"), Some(&id)),
                    Some(target) => {
                        v.check_connection(node, Some(target), &format!("Scene \"{title}\" early exit"));
                        v.add_edge(&id, Some(target));
                    }
                }
            }

            let mut required_count = 0;
            let completion = cfg.and_then(|c| c.completion.as_deref());
            for hotspot in cfg.and_then(|c| c.hotspots.as_ref()).into_iter().flatten() {
                if hotspot.required.unwrap_or(false) {
                    required_count += 1;
                }
                let hlabel = hotspot.label.as_deref().filter(|s| !s.is_empty()).or(hotspot.id.as_deref()).unwrap_or("").to_string();
                let target = hotspot.target_node_id.as_deref().filter(|s| !s.is_empty());
                v.check_connection(node, target, &format!("Hotspot \"{hlabel}\""));
                v.add_edge(&id, target);
                v.check_actions(node, hotspot.variable_actions.as_ref(), &format!("Hotspot \"{hlabel}\""));
                let inert = !hotspot.reveal.as_ref().map(js_truthy).unwrap_or(false)
                    && target.is_none()
                    && hotspot.variable_actions.as_ref().map(|a| a.is_empty()).unwrap_or(true)
                    && hotspot.conversation.is_none()
                    && hotspot.interaction.is_none();
                if inert {
                    v.warn("scene/inert-hotspot", format!("Hotspot \"{hlabel}\" on scene \"{title}\" does nothing: give it a question, a reveal, a route, a conversation, or variable actions"), Some(&id));
                }
                // A nested question answered in the room. Two traps: an
                // unanswerable one (no options), and, because a REQUIRED hotspot
                // is only satisfied once answered, an unanswerable REQUIRED one,
                // which strands the learner behind a gate they cannot open.
                if let Some(interaction) = &hotspot.interaction {
                    let where_ = format!("Hotspot \"{hlabel}\" on scene \"{title}\"");
                    let itype = interaction.interaction_type.as_deref().unwrap_or("");
                    let iconfig = interaction.config.as_deref();
                    let option_count = match itype {
                        "multipleChoice" => match iconfig.and_then(|c| c.choices.as_ref()) {
                            Some(Choices::Structured(list)) => list.len(),
                            _ => 0,
                        },
                        "ranking" => iconfig.and_then(|c| c.ranking_items.as_ref()).map(Vec::len).unwrap_or(0),
                        "matching" => iconfig.and_then(|c| c.matching_left_items.as_ref()).map(Vec::len).unwrap_or(0),
                        "procedure" => iconfig.and_then(|c| c.procedure_steps.as_ref()).map(Vec::len).unwrap_or(0),
                        "dragToTarget" => iconfig.and_then(|c| c.drag_items.as_ref()).map(Vec::len).unwrap_or(0),
                        // textInput / rating / message need no options
                        _ => 1,
                    };
                    if option_count == 0 {
                        let tail = if hotspot.required.unwrap_or(false) {
                            ", and it is REQUIRED, so they can never finish the scene"
                        } else {
                            ""
                        };
                        v.warn("scene/interaction-unanswerable", format!("{where_} asks a {itype} question with no options. The learner cannot answer it{tail}"), Some(&id));
                    }
                    if itype != "message"
                        && iconfig.and_then(|c| c.question.as_deref()).map(str::trim).unwrap_or("").is_empty()
                        && iconfig.and_then(|c| c.content.as_deref()).map(str::trim).unwrap_or("").is_empty()
                    {
                        v.warn("scene/interaction-no-question", format!("{where_} has a question type set but no question text"), Some(&id));
                    }
                    if let Some(Choices::Structured(list)) = iconfig.and_then(|c| c.choices.as_ref()) {
                        for choice in list {
                            let clabel = choice.text.as_deref().filter(|s| !s.is_empty()).or(choice.id.as_deref()).unwrap_or("");
                            v.check_actions(node, choice.actions.as_ref(), &format!("{where_} choice \"{clabel}\""));
                        }
                    }
                }
                // A required hotspot that also routes away defeats "find all":
                // the learner leaves the scene on its first click.
                if hotspot.required.unwrap_or(false) && target.is_some() && completion == Some("allRequired") {
                    v.warn("scene/required-hotspot-routes-away", format!("Hotspot \"{hlabel}\" on scene \"{title}\" is required AND routes to another node. Learners leave the scene when they click it, so they can never find the other required hotspots. Make it route OR be required, not both."), Some(&id));
                }
                if let Some(conv) = &hotspot.conversation {
                    if conv.persona.as_deref().map(str::trim).unwrap_or("").is_empty() {
                        v.warn("scene/character-no-persona", format!("Character hotspot \"{hlabel}\" on scene \"{title}\" has no persona yet"), Some(&id));
                    }
                    if let Some(svid) = conv.score_variable_id.as_deref().filter(|s| !s.is_empty()) {
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
                v.warn("conversation/no-objective", format!("Conversation node \"{title}\" has no objective. The AI can't assess the learner without one"), Some(&id));
            }
            if let Some(svid) = cfg.and_then(|c| c.score_variable_id.as_deref()).filter(|s| !s.is_empty()) {
                match v.lookup(svid) {
                    None => v.error("conversation/unknown-variable", format!("Conversation node \"{title}\" scores into a nonexistent variable"), Some(&id)),
                    Some(var) if var.computed => {
                        let vname = var.name.clone().unwrap_or_default();
                        v.error("conversation/computed-target", format!("Conversation node \"{title}\" scores into computed variable \"{vname}\""), Some(&id))
                    }
                    Some(var) if var.ty.as_deref() != Some("number") => {
                        let vname = var.name.clone().unwrap_or_default();
                        v.error("conversation/non-number", format!("Conversation node \"{title}\" scores into non-number variable \"{vname}\""), Some(&id))
                    }
                    _ => {}
                }
            }
        }

        if ntype == "rating" {
            if let Some(rvid) = cfg.and_then(|c| c.rating_variable_id.as_deref()).filter(|s| !s.is_empty()) {
                let title = node_label(node);
                match v.lookup(rvid) {
                    None => v.error("rating/unknown-variable", format!("Rating node \"{title}\" stores into a nonexistent variable"), Some(&id)),
                    Some(var) if var.computed => {
                        let vname = var.name.clone().unwrap_or_default();
                        v.error("rating/computed-target", format!("Rating node \"{title}\" stores into computed variable \"{vname}\""), Some(&id))
                    }
                    Some(var) if var.ty.as_deref() != Some("number") => {
                        let vname = var.name.clone().unwrap_or_default();
                        v.error("rating/non-number", format!("Rating node \"{title}\" stores into non-number variable \"{vname}\""), Some(&id))
                    }
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
                        v.warn("condition/no-default", format!("Condition node \"{title}\" has no default target. Learners whose answers match no criteria set will dead-end"), Some(&id));
                    }
                    if config.use_real_evaluation == Some(false) {
                        v.warn("condition/manual-mode", format!("Condition node \"{title}\" is in manual-selection mode (useRealEvaluation: false). Learners get real evaluation, but this is usually a leftover test setting"), Some(&id));
                    }
                }
            }
        }
    }

    // ── Module-level settings ────────────────────────────────────────────
    v.check_timer(module.settings.as_ref().and_then(|s| s.timer.as_ref()), "The module", None, Scope::Module);
    v.check_completion(module.settings.as_ref().and_then(|s| s.completion.as_ref()));

    // ── Pass marks must be reachable ─────────────────────────────────────
    // Best case for each non-computed number variable: an AI conversation or
    // rating target scores at most 100 / ratingMax; otherwise the largest
    // literal a "set" action can write. A counter that is incremented has no
    // known ceiling and is left alone. The raw config JSON is scanned (not the
    // typed model) so every nested action is seen, exactly as the reference
    // does.
    check_thresholds(content, &module, &mut v);

    // ── Placeholders reference defined variables ─────────────────────────
    let all_names: HashSet<String> = module
        .variables
        .iter()
        .filter_map(|v| v.name.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string))
        .collect();
    let raw_nodes = content.get("nodes").and_then(Value::as_array);
    for (index, node) in module.nodes.iter().enumerate() {
        let Some(id) = node.id.as_deref().filter(|s| !s.is_empty()) else { continue };
        if normalize_type(node.node_type.as_deref().unwrap_or("")) == "condition" {
            continue;
        }
        // Scan the raw config JSON so every string is seen exactly as written.
        let raw_cfg = raw_nodes.and_then(|nodes| nodes.get(index)).and_then(|n| n.get("config"));
        if let Some(raw_cfg) = raw_cfg {
            scan_strings(raw_cfg, id, &all_names, &mut v);
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

/// JavaScript truthiness of a JSON value (`!!x`).
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JavaScript `Number(x)` for a JSON value; `None` stands for `undefined`.
/// NaN comes back as NaN, so callers test `is_finite()` like the reference.
fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js_parse_number(s),
        // [] is 0 and [x] is Number(String(x)); anything longer is NaN.
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [only] => match only {
                Value::String(s) => js_parse_number(s),
                Value::Number(_) | Value::Null | Value::Bool(_) => js_number(Some(only)),
                Value::Array(_) => js_number(Some(only)),
                Value::Object(_) => f64::NAN,
            },
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `Number("...")`: whitespace-trimmed; empty is 0; decimal, hex, binary,
/// octal and Infinity literals; anything else is NaN.
fn js_parse_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    let (sign, body) = match t.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, t.strip_prefix('+').unwrap_or(t)),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    let radix = |prefix: &str, radix: u32| -> Option<f64> {
        let digits = body.strip_prefix(prefix).or_else(|| body.strip_prefix(&prefix.to_uppercase()))?;
        if sign < 0.0 || digits.is_empty() {
            return Some(f64::NAN);
        }
        u128::from_str_radix(digits, radix).ok().map(|n| n as f64).or(Some(f64::NAN))
    };
    if let Some(n) = radix("0x", 16).or_else(|| radix("0b", 2)).or_else(|| radix("0o", 8)) {
        return n;
    }
    // Rust's parser accepts "inf"/"nan"/"infinity", which JS does not.
    if body.chars().any(|c| c.is_ascii_alphabetic() && c != 'e' && c != 'E') {
        return f64::NAN;
    }
    body.parse::<f64>().map(|n| sign * n).unwrap_or(f64::NAN)
}

/// The "pass marks must be reachable" pass (see the call site).
fn check_thresholds(content: &Value, module: &Module, v: &mut Validator) {
    let variables = &module.variables;
    let number_ids: HashSet<&str> = variables
        .iter()
        .filter(|var| !var.computed.unwrap_or(false) && var.var_type.as_deref() == Some("number"))
        .filter_map(|var| var.id.as_deref().filter(|s| !s.is_empty()))
        .collect();
    let mut ceiling: HashMap<String, f64> = HashMap::new();
    let mut unbounded: HashSet<String> = HashSet::new();

    // A ceiling is only claimed for a variable with a writer we can see.
    // Anything written by a timer, a code node, a learner-scope sync or
    // nothing at all stays unknown and is never judged.
    fn raise(
        id: &str,
        n: f64,
        number_ids: &HashSet<&str>,
        unbounded: &HashSet<String>,
        ceiling: &mut HashMap<String, f64>,
        variables: &[crate::types::Variable],
    ) {
        if !number_ids.contains(id) || unbounded.contains(id) || !n.is_finite() {
            return;
        }
        let initial = variables
            .iter()
            .find(|var| var.id.as_deref() == Some(id))
            .and_then(|var| var.initial_value.as_ref());
        // `Number(initialValue) || 0`
        let init = js_number(initial);
        let init = if init.is_nan() { 0.0 } else { init };
        let current = ceiling.get(id).copied().unwrap_or(init);
        ceiling.insert(id.to_string(), current.max(n));
    }

    fn scan_actions(
        value: &Value,
        number_ids: &HashSet<&str>,
        unbounded: &mut HashSet<String>,
        ceiling: &mut HashMap<String, f64>,
        variables: &[crate::types::Variable],
    ) {
        match value {
            Value::Array(items) => {
                for item in items {
                    scan_actions(item, number_ids, unbounded, ceiling, variables);
                }
            }
            Value::Object(map) => {
                if map.contains_key("variableId") && map.contains_key("operator") {
                    let id = map.get("variableId").and_then(Value::as_str).unwrap_or("");
                    if !id.is_empty() && number_ids.contains(id) && !unbounded.contains(id) {
                        match map.get("operator") {
                            Some(Value::String(op)) if op == "set" => {
                                raise(id, js_number(map.get("value")), number_ids, unbounded, ceiling, variables)
                            }
                            Some(Value::String(_)) => {
                                unbounded.insert(id.to_string());
                                ceiling.remove(id);
                            }
                            _ => {}
                        }
                    }
                }
                for item in map.values() {
                    scan_actions(item, number_ids, unbounded, ceiling, variables);
                }
            }
            _ => {}
        }
    }

    let raw_nodes = content.get("nodes").and_then(Value::as_array);
    for (index, node) in module.nodes.iter().enumerate() {
        let ntype = normalize_type(node.node_type.as_deref().unwrap_or(""));
        let cfg = node.config.as_ref();
        if ntype == "conversation" && cfg.and_then(|c| c.score_variable_id.as_deref()).is_some() {
            let svid = cfg.and_then(|c| c.score_variable_id.as_deref()).unwrap_or("");
            raise(svid, 100.0, &number_ids, &unbounded, &mut ceiling, variables);
        } else if ntype == "rating" && cfg.and_then(|c| c.rating_variable_id.as_deref()).is_some() {
            let rvid = cfg.and_then(|c| c.rating_variable_id.as_deref()).unwrap_or("");
            let max = cfg.and_then(|c| c.rating_max).filter(|m| m.is_finite() && *m != 0.0).unwrap_or(5.0);
            raise(rvid, max, &number_ids, &unbounded, &mut ceiling, variables);
        } else if ntype != "condition" {
            let raw_cfg = raw_nodes.and_then(|nodes| nodes.get(index)).and_then(|n| n.get("config"));
            if let Some(raw_cfg) = raw_cfg {
                scan_actions(raw_cfg, &number_ids, &mut unbounded, &mut ceiling, variables);
            }
        }
    }

    let mut by_name: HashMap<String, f64> = HashMap::new();
    for var in variables {
        if var.computed.unwrap_or(false) {
            continue;
        }
        if let Some(c) = var.id.as_deref().filter(|s| !s.is_empty()).and_then(|id| ceiling.get(id)) {
            by_name.insert(var.name.clone().unwrap_or_else(|| "undefined".to_string()), *c);
        }
    }
    let ceiling_of = |var: &crate::types::Variable| -> Option<f64> {
        if var.computed.unwrap_or(false) {
            let formula = var.formula.as_deref().filter(|s| !s.is_empty())?;
            // An invalid formula is already reported as variable/formula-invalid;
            // here it simply has no ceiling. (The platform once threw out of the
            // whole validation at this point; fixed Sep 2026 to match.)
            let refs = formula::identifiers(formula).ok()?;
            if refs.iter().any(|name| !by_name.contains_key(name)) {
                return None;
            }
            return Some(formula::evaluate(formula, &by_name));
        }
        var.id.as_deref().and_then(|id| ceiling.get(id)).copied()
    };
    let judge = |var: &crate::types::Variable, operator: Option<&str>, raw: Option<&Value>, where_: &str, node_id: Option<&str>, v: &mut Validator| {
        let Some(op) = operator.filter(|o| *o == ">=" || *o == ">") else { return };
        let threshold = js_number(raw);
        if !threshold.is_finite() {
            return;
        }
        let Some(max) = ceiling_of(var) else { return };
        let vname = var.name.clone().unwrap_or_default();
        if threshold > max {
            v.error("threshold/unreachable", format!("{where_} needs \"{vname}\" {op} {threshold}, but the most it can ever reach is {max}"), node_id);
        } else if max - threshold < 10.0 {
            v.warn("threshold/tight", format!("{where_} needs \"{vname}\" {op} {threshold}; the most it can reach is {max}, so only a near-perfect run passes. Put every scored input on a 0-100 scale."), node_id);
        }
    };

    // Lookups mirror the reference's Maps: the last definition wins on a
    // duplicate id or name.
    let by_id_lookup = |id: &str| -> Option<&crate::types::Variable> {
        if id.is_empty() {
            return None;
        }
        variables.iter().rev().find(|var| var.id.as_deref() == Some(id))
    };
    let mut by_name_lookup: HashMap<&str, &crate::types::Variable> = HashMap::new();
    for var in variables {
        if let Some(name) = var.name.as_deref() {
            by_name_lookup.insert(name, var);
        }
    }

    let completion = module.settings.as_ref().and_then(|s| s.completion.as_ref());
    if let Some(rule) = completion {
        let mode = rule.mode.as_deref().filter(|s| !s.is_empty()).unwrap_or("variable");
        if mode == "variable" {
            if let Some(vid) = rule.variable_id.as_deref().filter(|s| !s.is_empty()) {
                if let Some(var) = by_id_lookup(vid).filter(|var| var.var_type.as_deref() == Some("number")) {
                    judge(var, rule.operator.as_deref(), rule.value.as_ref(), "The module's pass rule", None, v);
                }
            }
        }
    }
    for node in &module.nodes {
        if normalize_type(node.node_type.as_deref().unwrap_or("")) != "condition" {
            continue;
        }
        let Some(config) = parse_condition_config(node) else { continue };
        let title = node_label(node);
        for set in &config.criteria_sets {
            for c in &set.conditions {
                let Some(field) = c.field.as_deref().filter(|s| !s.is_empty()) else { continue };
                let var = by_id_lookup(field).or_else(|| by_name_lookup.get(field).copied());
                if let Some(var) = var.filter(|var| var.var_type.as_deref() == Some("number")) {
                    judge(var, c.operator.as_deref(), c.value.as_ref(), &format!("Condition \"{title}\""), node.id.as_deref(), v);
                }
            }
        }
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
