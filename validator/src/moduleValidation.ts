// Module content validation — pure functions, no React, no Supabase.
//
// Used by three callers:
//  - the builder (surface problems to creators before learners hit them)
//  - the test suite (broken fixtures fail loudly)
//  - the AI copilot (generated JSON must pass before it reaches the canvas)
//
// Errors mean the module is broken for learners; warnings mean it's legal
// but suspicious (unreachable nodes, missing condition defaults, etc.).

import { parseFormula, FormulaError } from "./formulaEval";
import type {
  Node,
  VariableDefinition,
  VariableAction,
  TimerConfig,
  ModuleSettings,
} from "./types";

export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ModuleContent {
  nodes?: Node[];
  variables?: VariableDefinition[];
  settings?: ModuleSettings;
}

const LEGACY_TYPE_MAP: Record<string, string> = {
  router: "choice",
  decisionPath: "condition",
};

const NODE_TYPES = new Set([
  "message",
  "video",
  "choice",
  "textInput",
  "multipleChoice",
  "ranking",
  "matching",
  "rating",
  "condition",
  "scene", // immersive environment with hotspots (Stage 2)
  "conversation", // learner chats with an AI character (Stage 2 Phase 4)
  "code", // sandboxed creator/AI-authored JS (2D canvas or 3D world)
  "note", // canvas-only annotation — exempt from flow checks
]);

const VARIABLE_TYPES = new Set(["number", "boolean", "text"]);

// Operators legal per variable type ("set" is legal on anything)
const OPERATORS_FOR_TYPE: Record<string, Set<string>> = {
  number: new Set(["set", "increment", "decrement", "multiply", "divide"]),
  boolean: new Set(["set", "set_true", "set_false", "toggle"]),
  text: new Set(["set"]),
};

const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

function normalizeType(type: string): string {
  return LEGACY_TYPE_MAP[type] ?? type;
}

/** Parse a condition node's criteria configuration. Two accepted forms
 *  (docs/ronu-spec-v0.9.md §8): canonical — a parsed object at
 *  `config.criteria` (what .ronu exporters emit); legacy — a JSON string at
 *  `config.choices` (what the builder writes internally). */
export function parseConditionConfig(node: Node):
  | {
      criteriaSets: Array<{
        id?: string;
        targetNodeId?: string;
        conditions?: Array<{ field: string; operator?: string; value?: unknown }>;
      }>;
      defaultTargetNodeId?: string;
      useRealEvaluation?: boolean;
    }
  | null {
  let parsed: unknown;
  if (node.config?.criteria && typeof node.config.criteria === "object") {
    parsed = node.config.criteria;
  } else if (node.config?.choices && typeof node.config.choices === "string") {
    try {
      parsed = JSON.parse(node.config.choices);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  const obj = parsed as {
    criteriaSets?: unknown;
    defaultTargetNodeId?: string;
    useRealEvaluation?: boolean;
  };
  return {
    criteriaSets: Array.isArray(obj.criteriaSets) ? obj.criteriaSets : [],
    defaultTargetNodeId: obj.defaultTargetNodeId || undefined,
    useRealEvaluation: obj.useRealEvaluation,
  };
}

export function validateModuleContent(content: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const error = (code: string, message: string, nodeId?: string) =>
    errors.push({ code, message, nodeId });
  const warn = (code: string, message: string, nodeId?: string) =>
    warnings.push({ code, message, nodeId });

  // ── Shape ─────────────────────────────────────────────────────────────────
  if (!content || typeof content !== "object") {
    error("content/invalid", "Module content must be an object");
    return { valid: false, errors, warnings };
  }
  const { nodes, variables = [], settings } = content as ModuleContent;
  if (!Array.isArray(nodes)) {
    error("nodes/missing", "Module content must contain a nodes array");
    return { valid: false, errors, warnings };
  }

  // ── Variables ─────────────────────────────────────────────────────────────
  const variableById = new Map<string, VariableDefinition>();
  const nonComputedNames = new Set<string>();
  const seenNames = new Set<string>();
  for (const v of variables) {
    if (!v.id) error("variable/no-id", `Variable "${v.name || "?"}" has no id`);
    if (!v.name?.trim()) {
      error("variable/no-name", `Variable ${v.id || "?"} has no name`);
    } else if (seenNames.has(v.name.trim())) {
      error("variable/duplicate-name", `Duplicate variable name "${v.name}"`);
    } else {
      seenNames.add(v.name.trim());
    }
    if (!VARIABLE_TYPES.has(v.type)) {
      error("variable/bad-type", `Variable "${v.name}" has unknown type "${v.type}"`);
    }
    if (v.computed) {
      if (v.type !== "number") {
        error("variable/computed-not-number", `Computed variable "${v.name}" must be a number`);
      }
      if (!v.formula?.trim()) {
        error("variable/computed-no-formula", `Computed variable "${v.name}" has no formula`);
      }
    } else {
      if (v.type === "number" && typeof v.initialValue !== "number") {
        error("variable/initial-mismatch", `Variable "${v.name}" is a number but its initial value isn't`);
      }
      if (v.type === "boolean" && typeof v.initialValue !== "boolean") {
        error("variable/initial-mismatch", `Variable "${v.name}" is a boolean but its initial value isn't`);
      }
      if (v.name?.trim()) nonComputedNames.add(v.name.trim());
    }
    if (v.id) variableById.set(v.id, v);
  }
  // Computed formulas: parseable, referencing only non-computed variables
  for (const v of variables) {
    if (!v.computed || !v.formula?.trim()) continue;
    try {
      const { identifiers } = parseFormula(v.formula);
      for (const name of identifiers) {
        if (!nonComputedNames.has(name)) {
          error(
            "variable/formula-unknown-ref",
            `Computed variable "${v.name}" references "${name}", which is not a non-computed variable`
          );
        }
      }
    } catch (err) {
      error(
        "variable/formula-invalid",
        `Computed variable "${v.name}" has an invalid formula: ${
          err instanceof FormulaError ? err.message : "parse error"
        }`
      );
    }
  }

  // ── Nodes: ids, types, start node ─────────────────────────────────────────
  const nodeIds = new Set<string>();
  let startCount = 0;
  for (const node of nodes) {
    if (!node.id) {
      error("node/no-id", `A ${node.type || "?"} node has no id`);
      continue;
    }
    if (nodeIds.has(node.id)) error("node/duplicate-id", `Duplicate node id "${node.id}"`, node.id);
    nodeIds.add(node.id);
    if (!NODE_TYPES.has(normalizeType(node.type))) {
      error("node/unknown-type", `Node "${node.id}" has unknown type "${node.type}"`, node.id);
    }
    if (node.config?.isStart) startCount++;
  }
  if (nodes.length > 0 && startCount === 0) {
    error("module/no-start", "Module has no start node");
  }
  if (startCount > 1) {
    error("module/multiple-starts", `Module has ${startCount} start nodes — there must be exactly one`);
  }

  const checkConnection = (from: Node, target: unknown, what: string) => {
    if (target && typeof target === "string" && !nodeIds.has(target)) {
      error(
        "connection/dangling",
        `${what} on node "${from.config?.title || from.id}" points at nonexistent node "${target}"`,
        from.id
      );
    }
  };

  const checkActions = (from: Node, actions: VariableAction[] | undefined, what: string) => {
    for (const action of actions || []) {
      if (!action.variableId) continue;
      const variable = variableById.get(action.variableId);
      if (!variable) {
        error("action/unknown-variable", `${what} on node "${from.config?.title || from.id}" targets a nonexistent variable`, from.id);
        continue;
      }
      if (variable.computed) {
        error("action/computed-target", `${what} on node "${from.config?.title || from.id}" targets computed variable "${variable.name}" — computed variables are read-only`, from.id);
      }
      const legal = OPERATORS_FOR_TYPE[variable.type];
      if (legal && action.operator && !legal.has(action.operator)) {
        error("action/bad-operator", `${what} on node "${from.config?.title || from.id}" uses operator "${action.operator}" on ${variable.type} variable "${variable.name}"`, from.id);
      }
    }
  };

  // Validate a number variable an action/timer writes into (must exist,
  // be non-computed, and be a number).
  const checkNumberTarget = (
    code: string,
    variableId: string | undefined,
    ctx: string,
    nodeId: string | undefined
  ) => {
    if (!variableId) return;
    const variable = variableById.get(variableId);
    if (!variable) {
      error(`${code}-unknown`, `${ctx} targets a nonexistent variable`, nodeId);
    } else if (variable.computed || variable.type !== "number") {
      error(`${code}-bad`, `${ctx} must use a non-computed number variable`, nodeId);
    }
  };

  // Timers (node/scene via config.timer, module via settings.timer)
  const checkTimer = (
    timer: TimerConfig | undefined,
    ctx: string,
    nodeId: string | undefined,
    scope: "node" | "module"
  ) => {
    if (!timer) return;
    if (timer.mode !== "countdown" && timer.mode !== "countup") {
      error("timer/bad-mode", `${ctx} timer has an invalid mode`, nodeId);
      return;
    }
    if (timer.mode === "countdown") {
      if (typeof timer.seconds !== "number" || timer.seconds <= 0) {
        error("timer/no-seconds", `${ctx} countdown timer needs a positive time limit`, nodeId);
      }
      // "Turn red at (seconds left)" must leave a green window — if it's at or
      // above the time limit the timer starts red and never looks normal.
      if (
        typeof timer.warnAtSeconds === "number" &&
        typeof timer.seconds === "number" &&
        timer.seconds > 0 &&
        timer.warnAtSeconds >= timer.seconds
      ) {
        warn(
          "timer/warn-at-too-high",
          `${ctx} timer turns red at ${timer.warnAtSeconds}s left, which is at or above its ${timer.seconds}s limit — it will start red. Set the warning lower.`,
          nodeId
        );
      }
      const behavior = timer.onExpire?.behavior;
      if (behavior === "route") {
        if (!timer.onExpire?.targetNodeId) {
          warn("timer/route-no-target", `${ctx} timer routes when time runs out, but no destination is set`, nodeId);
        } else if (!nodeIds.has(timer.onExpire.targetNodeId)) {
          error("timer/route-dangling", `${ctx} timer routes on expiry to a node that doesn't exist`, nodeId);
        }
      }
      if (scope === "module" && behavior === "advance") {
        warn("timer/module-advance", `The module timer can't "go to the next node" — use route to a specific node or end the module instead`, nodeId);
      }
      // onExpire variable actions reference real, writable variables
      for (const action of timer.onExpire?.actions || []) {
        if (!action.variableId) continue;
        const variable = variableById.get(action.variableId);
        if (!variable) {
          error("timer/action-unknown-variable", `${ctx} timer's expiry action targets a nonexistent variable`, nodeId);
        } else if (variable.computed) {
          error("timer/action-computed", `${ctx} timer's expiry action targets computed variable "${variable.name}" (read-only)`, nodeId);
        }
      }
    } else if (timer.onExpire?.behavior && timer.onExpire.behavior !== "none") {
      warn("timer/countup-onexpire", `${ctx} is a count-up (stopwatch) timer, so its "when time runs out" action is ignored`, nodeId);
    }
    // recordVariableId (both modes) must be a non-computed number variable
    checkNumberTarget("timer/record", timer.recordVariableId, `${ctx} timer's "record elapsed time" variable`, nodeId);
  };

  // Module pass/fail rule (settings.completion)
  const checkCompletion = (rule: ModuleSettings["completion"]) => {
    if (!rule) return;
    const mode = rule.mode ?? "variable";
    if (mode === "reachedNode") {
      if (!rule.passNodeId) {
        warn("completion/no-node", "The module's pass rule has no target node selected");
      } else if (!nodeIds.has(rule.passNodeId)) {
        error("completion/dangling-node", "The module's pass rule requires reaching a node that doesn't exist");
      }
      return;
    }
    if (mode === "nodeScore") {
      if (rule.scoreNodeId && !nodeIds.has(rule.scoreNodeId)) {
        error("completion/dangling-node", "The module's pass rule grades a node that doesn't exist");
      }
      if (!rule.operator) {
        warn("completion/no-operator", "The module's score pass rule has no comparison set");
      }
      return;
    }
    // variable mode
    if (!rule.variableId) {
      warn("completion/no-variable", "The module's pass rule has no variable selected");
      return;
    }
    const variable = variableById.get(rule.variableId);
    if (!variable) {
      error("completion/unknown-variable", "The module's pass rule references a variable that doesn't exist");
      return;
    }
    if (!rule.operator) {
      warn("completion/no-operator", `The module's pass rule on "${variable.name}" has no comparison set`);
      return;
    }
    const numericOps = new Set([">=", ">", "<=", "<"]);
    const boolOps = new Set(["is_true", "is_false"]);
    if (numericOps.has(rule.operator) && variable.type !== "number") {
      error("completion/op-type", `The module's pass rule uses a numeric comparison on non-number variable "${variable.name}"`);
    } else if (boolOps.has(rule.operator) && variable.type !== "boolean") {
      error("completion/op-type", `The module's pass rule uses true/false on non-boolean variable "${variable.name}"`);
    } else if (rule.operator === "contains" && variable.type !== "text") {
      error("completion/op-type", `The module's pass rule uses "contains" on non-text variable "${variable.name}"`);
    }
  };

  // ── Per-node checks ───────────────────────────────────────────────────────
  // edges: nodeId -> reachable nodeIds (for the reachability pass)
  const edges = new Map<string, string[]>();
  const addEdge = (from: string, to: unknown) => {
    if (to && typeof to === "string") {
      edges.set(from, [...(edges.get(from) || []), to]);
    }
  };

  for (const node of nodes) {
    if (!node.id) continue;
    const type = normalizeType(node.type);

    checkConnection(node, node.connection, "Connection");
    addEdge(node.id, node.connection);

    for (const trigger of node.config?.triggers || []) {
      checkActions(node, trigger.actions, `Trigger "${trigger.type}"`);
    }

    // Node/scene timer (config.timer). A countdown that routes on expiry is a
    // real edge, so feed it into the reachability graph.
    checkTimer(node.config?.timer, `Node "${node.config?.title || node.id}"`, node.id, "node");
    if (node.config?.timer?.mode === "countdown" && node.config.timer.onExpire?.behavior === "route") {
      addEdge(node.id, node.config.timer.onExpire.targetNodeId);
    }

    if (type === "choice" || type === "multipleChoice") {
      const choices = Array.isArray(node.config?.choices) ? node.config.choices : [];
      for (const choice of choices) {
        if (type === "choice") {
          checkConnection(node, choice.connection, `Choice "${choice.text || choice.id}"`);
          addEdge(node.id, choice.connection);
        }
        checkActions(node, choice.actions, `Choice "${choice.text || choice.id}"`);
      }
      if (type === "choice" && choices.length === 0) {
        warn("choice/empty", `Choice node "${node.config?.title || node.id}" has no choices`, node.id);
      }
    }

    if (type === "matching") {
      for (const item of node.config?.matchingLeftItems || []) {
        checkActions(node, (item as { actions?: VariableAction[] }).actions, "Matching item");
      }
    }

    if (type === "scene") {
      const title = node.config?.title || node.id;
      if (!node.config?.environment?.source) {
        warn("scene/no-environment", `Scene node "${title}" has no environment image yet`, node.id);
      }
      const hotspots = node.config?.hotspots || [];
      let requiredCount = 0;
      for (const hotspot of hotspots) {
        if (hotspot.required) requiredCount++;
        checkConnection(node, hotspot.targetNodeId, `Hotspot "${hotspot.label || hotspot.id}"`);
        addEdge(node.id, hotspot.targetNodeId);
        checkActions(node, hotspot.variableActions, `Hotspot "${hotspot.label || hotspot.id}"`);
        if (
          !hotspot.reveal &&
          !hotspot.targetNodeId &&
          !hotspot.variableActions?.length &&
          !hotspot.conversation
        ) {
          warn("scene/inert-hotspot", `Hotspot "${hotspot.label || hotspot.id}" on scene "${title}" does nothing — give it a reveal, a route, a conversation, or variable actions`, node.id);
        }
        // A required hotspot that also routes away defeats "find all" — the
        // learner leaves the scene on its first click, never finding the rest
        if (
          hotspot.required &&
          hotspot.targetNodeId &&
          node.config?.completion === "allRequired"
        ) {
          warn(
            "scene/required-hotspot-routes-away",
            `Hotspot "${hotspot.label || hotspot.id}" on scene "${title}" is required AND routes to another node — learners leave the scene when they click it, so they can never find the other required hotspots. Make it route OR be required, not both.`,
            node.id
          );
        }
        if (hotspot.conversation) {
          if (!hotspot.conversation.persona?.trim()) {
            warn("scene/character-no-persona", `Character hotspot "${hotspot.label || hotspot.id}" on scene "${title}" has no persona yet`, node.id);
          }
          const scoreVarId = hotspot.conversation.scoreVariableId;
          if (scoreVarId) {
            const variable = variableById.get(scoreVarId);
            if (!variable) {
              error("scene/character-unknown-variable", `Character hotspot "${hotspot.label || hotspot.id}" on scene "${title}" scores into a nonexistent variable`, node.id);
            } else if (variable.computed || variable.type !== "number") {
              error("scene/character-bad-variable", `Character hotspot "${hotspot.label || hotspot.id}" on scene "${title}" must score into a non-computed number variable`, node.id);
            }
          }
        }
      }
      checkActions(node, node.config?.missActions, "Wrong-guess actions");
      if (node.config?.completion === "allRequired" && requiredCount === 0) {
        error("scene/no-required-hotspots", `Scene "${title}" requires all hotspots to be visited, but none are marked required`, node.id);
      }
    }

    if (type === "conversation") {
      const title = node.config?.title || node.id;
      if (!node.config?.persona?.trim()) {
        warn("conversation/no-persona", `Conversation node "${title}" has no character persona yet`, node.id);
      }
      if (!node.config?.objective?.trim()) {
        warn("conversation/no-objective", `Conversation node "${title}" has no objective — the AI can't assess the learner without one`, node.id);
      }
      if (node.config?.scoreVariableId) {
        const variable = variableById.get(node.config.scoreVariableId);
        if (!variable) {
          error("conversation/unknown-variable", `Conversation node "${title}" scores into a nonexistent variable`, node.id);
        } else if (variable.computed) {
          error("conversation/computed-target", `Conversation node "${title}" scores into computed variable "${variable.name}"`, node.id);
        } else if (variable.type !== "number") {
          error("conversation/non-number", `Conversation node "${title}" scores into non-number variable "${variable.name}"`, node.id);
        }
      }
    }

    if (type === "rating" && node.config?.ratingVariableId) {
      const variable = variableById.get(node.config.ratingVariableId);
      if (!variable) {
        error("rating/unknown-variable", `Rating node "${node.config?.title || node.id}" stores into a nonexistent variable`, node.id);
      } else if (variable.computed) {
        error("rating/computed-target", `Rating node "${node.config?.title || node.id}" stores into computed variable "${variable.name}"`, node.id);
      } else if (variable.type !== "number") {
        error("rating/non-number", `Rating node "${node.config?.title || node.id}" stores into non-number variable "${variable.name}"`, node.id);
      }
    }

    if (type === "condition") {
      const config = parseConditionConfig(node);
      if (!config) {
        error("condition/unparseable", `Condition node "${node.config?.title || node.id}" has missing or invalid criteria configuration`, node.id);
        continue;
      }
      for (const set of config.criteriaSets) {
        checkConnection(node, set.targetNodeId, "Condition target");
        addEdge(node.id, set.targetNodeId);
        for (const condition of set.conditions || []) {
          if (condition.field === "operator") continue;
          if (
            condition.field &&
            !nodeIds.has(condition.field) &&
            !variableById.has(condition.field)
          ) {
            error(
              "condition/unknown-ref",
              `Condition on node "${node.config?.title || node.id}" references "${condition.field}", which is neither a node nor a variable`,
              node.id
            );
          }
        }
      }
      checkConnection(node, config.defaultTargetNodeId, "Condition default target");
      addEdge(node.id, config.defaultTargetNodeId);
      if (!config.defaultTargetNodeId) {
        warn(
          "condition/no-default",
          `Condition node "${node.config?.title || node.id}" has no default target — learners whose answers match no criteria set will dead-end`,
          node.id
        );
      }
      if (config.useRealEvaluation === false) {
        warn(
          "condition/manual-mode",
          `Condition node "${node.config?.title || node.id}" is in manual-selection mode (useRealEvaluation: false) — learners get real evaluation, but this is usually a leftover test setting`,
          node.id
        );
      }
    }
  }

  // ── Module-level settings (whole-module timer + pass/fail rule) ───────────
  checkTimer(settings?.timer, "The module", undefined, "module");
  checkCompletion(settings?.completion);

  // ── Placeholders reference defined variables ──────────────────────────────
  const allNames = new Set(variables.map((v) => v.name?.trim()).filter(Boolean));
  const scanStrings = (value: unknown, nodeId: string) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
        if (!allNames.has(match[1])) {
          warn(
            "placeholder/unknown",
            `Node "${nodeId}" uses {${match[1]}}, which is not a defined variable`,
            nodeId
          );
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach((v) => scanStrings(v, nodeId));
    } else if (value && typeof value === "object") {
      Object.values(value).forEach((v) => scanStrings(v, nodeId));
    }
  };
  for (const node of nodes) {
    if (!node.id || normalizeType(node.type) === "condition") continue;
    scanStrings(node.config, node.id);
  }

  // ── Reachability from the start node ──────────────────────────────────────
  const start = nodes.find((n) => n.config?.isStart) || nodes[0];
  if (start?.id) {
    const reachable = new Set<string>([start.id]);
    const queue = [start.id];
    while (queue.length) {
      const current = queue.shift()!;
      for (const next of edges.get(current) || []) {
        if (nodeIds.has(next) && !reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
    for (const node of nodes) {
      if (normalizeType(node.type) === "note") continue; // annotations aren't part of the flow
      if (node.id && !reachable.has(node.id)) {
        warn(
          "node/unreachable",
          `Node "${node.config?.title || node.id}" cannot be reached from the start node`,
          node.id
        );
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
