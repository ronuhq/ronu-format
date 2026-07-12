// @ronuhq/validator — reference validator for the .ronu format.
//
// The executable arbiter of "valid module.json" per the spec (§6). Pure
// functions, zero runtime dependencies. Vendored from the originating
// RonuNest platform implementation (v0.9 baseline, 12 Jul 2026).

export {
  validateModuleContent,
  parseConditionConfig,
  type ValidationResult,
  type ValidationIssue,
  type ModuleContent,
} from "./src/moduleValidation";

export type {
  Node,
  NodeConfig,
  VariableDefinition,
  VariableAction,
  ModuleSettings,
  CompletionRule,
  TimerConfig,
  SceneEnvironment,
  SceneHotspot,
  ConditionConfig,
} from "./src/types";
