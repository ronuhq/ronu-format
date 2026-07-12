export interface Point {
  x: number;
  y: number;
}

/** A file a creator attached to a message node.
 *  New shape (2026-07): `path` is a bucket-prefixed storage ref
 *  ("module-content/{creator_id}/…") resolved to a signed URL at view time.
 *  Legacy shape: `data` carries the whole file as a base64 data URL embedded
 *  in module content — still rendered, never written anymore. */
export interface AttachedFile {
  id: string;
  name: string;
  /** New: bucket-prefixed storage ref. */
  path?: string;
  size?: number;
  mimeType?: string;
  /** Legacy: transient object URL from the upload session (dead after reload). */
  url?: string;
  /** Legacy: base64 data URL of the full file. */
  data?: string;
}

export function isLegacyAttachment(f: AttachedFile): boolean {
  return !!f.data;
}

// Conditional Branch specific types
export interface Condition {
  id: string;
  field: string; // Node ID or 'operator'
  operator: string;
  value: string;
}

export interface CriteriaSet {
  id: string;
  conditions: Condition[];
  targetNodeId: string;
  pathLabel: string;
}

export interface ConditionConfig {
  criteriaSets: CriteriaSet[];
  defaultTargetNodeId: string;
  defaultPathLabel: string;
}

// ─── Scene node (Stage 2 — immersive environments) ────────────────────────

/** What renders behind the hotspots. The renderer is swappable; the
    interaction layer (hotspots → variable actions → routing) is not. */
export interface SceneEnvironment {
  kind: "photo360" | "photo2d" | "splat" | "embed3d";
  /** Media-library URL: equirectangular 2:1 image (photo360),
      a normal flat image (photo2d), .splat/.ply (splat), or embed URL (embed3d) */
  source: string;
}

/** One emotional state the character can be in. The `label` is shown to the
    creator AND sent to the AI, which picks the best-matching state each turn;
    `cue` is an optional hint that steers that choice. */
export interface ConversationState {
  id: string;
  /** e.g. "furious", "reassured" — sent to the AI as a selectable mood */
  label: string;
  /** Sprite shown in this state */
  sprite?: string;
  /** Optional hint for the AI, e.g. "shouting, threatening to leave" */
  cue?: string;
}

/** Optional visual-novel presentation for a conversation: a background, a
    named character, and a set of emotional states (each a labelled sprite) that
    the AI swaps between as the conversation goes. When absent, the conversation
    renders as a plain chat box. The FIRST state is the default/fallback. */
export interface ConversationVisual {
  /** Background image (media-library path or URL). In-scene uses the panorama instead. */
  background?: string;
  /** Name shown by the speech bubble */
  characterName?: string;
  /** Curated voice id (see the synthesize-speech edge fn) — when set, the
      character's lines are spoken aloud (TTS). Empty = read silently. */
  voice?: string;
  /** 1–6 creator-defined emotional states; the first is the default/fallback */
  states?: ConversationState[];
}

export interface SceneHotspot {
  id: string;
  /** photo360 anchors with yaw/pitch (radians); photo2d with normalized
      x/y in [0,1] (fraction of the image); splat/embed3d with x/y/z */
  position: { yaw?: number; pitch?: number; x?: number; y?: number; z?: number };
  label: string;
  /** Counts toward completion when the scene is set to "allRequired" */
  required?: boolean;
  /** Hidden until found — the learner must click where it is (discovery).
      Per-hotspot so one scene can mix hidden hazards with visible characters. */
  hidden?: boolean;
  /** Inline overlay shown on click, without leaving the scene */
  reveal?: { kind: "text" | "image" | "video"; body?: string; url?: string };
  /** Route to another node on click (after the reveal is dismissed, if both) */
  targetNodeId?: string;
  /** Fired on first click — same shape as node trigger actions */
  variableActions?: VariableAction[];
  /** This hotspot is a character: clicking opens an in-scene chat overlay */
  conversation?: {
    persona: string;
    firstMessage?: string;
    objective?: string;
    maxTurns?: number;
    scoreVariableId?: string;
    visual?: ConversationVisual;
  };
}

export interface NodeConfig {
  title: string;
  content?: string;
  files?: AttachedFile[];
  connection?: string; // Single connection for non-router nodes
  required?: boolean;
  videoUrl?: string;
  thumbnailUrl?: string;
  videoControls?: {
    autoplay?: boolean;
    showPlayPause?: boolean;
    showVolume?: boolean;
    showSubtitles?: boolean;
    allowSeeking?: boolean;
  };
  question?: string;
  text?: string;
  choices?: Array<{
    id: string;
    text: string;
    connection?: string; // Connection for each choice in router nodes
    actions?: VariableAction[]; // Variable actions fired when this choice is selected
    condition?: {
      componentId: string;
      operator: string;
      value: string;
    };
  }> | string; // String for Conditional Branch nodes (JSON format)
  /** Condition nodes, canonical .ronu form: the criteria as a parsed object
   *  (spec docs/ronu-spec-v0.9.md §8). The builder still writes the stringified
   *  form into `choices`; exporters emit this and readers accept either. */
  criteria?: ConditionConfig;
  overlay?: boolean; // Whether the router appears as an overlay
  allowMultiple?: boolean;
  // Typeform-style: selecting the answer records it and advances to the next
  // node (after a brief highlight) instead of requiring a Continue click.
  // Only honored for single-answer nodes — Rating and single-select
  // MultipleChoice (ignored when allowMultiple is true).
  advanceOnAnswer?: boolean;
  rankingItems?: string[];
  matchingLeftItems?: Array<{ id: string; text: string; correctRightId?: string; actions?: VariableAction[] }>;
  matchingRightItems?: Array<{ id: string; text: string }>;
  // When false, the matching node is an ungraded sorting activity: no
  // "Check Answers"/scoring step, learners just match and continue.
  // Defaults to true (graded) when undefined.
  matchingGraded?: boolean;
  ratingVariableId?: string;
  ratingMin?: number;
  ratingMax?: number;
  ratingStyle?: "stars" | "numbers" | "emoji";
  ratingEmoji?: string;
  ratingLowLabel?: string;
  ratingHighLabel?: string;
  isStart?: boolean;
  allowPrevious: boolean;
  subtitlesUrl: string;
  defaultRoute?: {
    targetNodeId?: string;
    label?: string;
  };
  triggers?: NodeTrigger[];
  /** Visible game-style timer for this node/scene (countdown or stopwatch) */
  timer?: TimerConfig;
  showContinueButton?: boolean;
  // Scene node (type "scene") — see SceneEnvironment/SceneHotspot above
  environment?: SceneEnvironment;
  hotspots?: SceneHotspot[];
  instructions?: string;
  completion?: "free" | "allRequired";
  /** Hotspot unlock order. "ordered" reveals them one at a time in list order
      (the next is active, earlier ones stay done, later ones are locked).
      Defaults to "free" (all clickable at once) when undefined. */
  hotspotSequence?: "free" | "ordered";
  /** LEGACY scene-wide visibility — superseded by per-hotspot `hidden`.
      Old scenes with "hidden" here treat non-character hotspots as hidden. */
  hotspotVisibility?: "visible" | "hidden";
  /** Discovery click tolerance in radians (default 0.35) */
  discoveryRadius?: number;
  /** Discovery mode: fired on every wrong-guess click (honest scoring) */
  missActions?: VariableAction[];
  // Conversation node (type "conversation") — learner talks to an AI character
  /** Who the character is and the scenario, written to the model as-is */
  persona?: string;
  /** The character's opening message (shown before the learner types) */
  firstMessage?: string;
  /** What the learner should accomplish + how to grade it (the rubric) */
  objective?: string;
  /** Learner turns before the conversation auto-ends (default 6) */
  maxTurns?: number;
  /** Number variable that receives the 0-100 assessment score */
  scoreVariableId?: string;
  /** Optional visual-novel presentation (background + mood sprites) */
  visual?: ConversationVisual;

  // Code node (type "code") — sandboxed creator/AI-authored behaviour
  /** The body of an async run({ ctx, ui, emit }) — see docs/code-node-sdk.md */
  source?: string;
  /** Industry 3D asset-pack slug (sim_assets registry) — the copilot builds
   *  from this pack's catalog and the hosts ship its referenced GLBs */
  assetPack?: string;
  /** Per-node custom GLB overrides ({ key: url }) — generated props (Phase 3)
   *  or hand-supplied URLs. Resolved over the pack by simAssets.resolveAssets3d;
   *  world.load("key") uses them. */
  assets3d?: Record<string, string>;
  /** Room aesthetics (the Room panel) — floor/walls/ceiling swap + door/window/
   *  posters. The sandbox merges this OVER the sim's ui.world opts, so it restyles
   *  any 3D node without editing code. */
  room?: {
    room?: string;
    floor?: { pattern?: string; color?: number };
    walls?: { color?: number };
    ceiling?: { color?: number };
    door?: { wall?: string; position?: number; exit?: boolean };
    window?: { wall?: string; position?: number };
    posters?: Array<{
      image?: string;
      /** text sign (SDK-rendered) — used when no image is set */
      text?: string;
      bg?: string;
      color?: string;
      wall?: "north" | "south" | "east" | "west";
      position?: number;
      size?: { w?: number; h?: number };
      y?: number;
    }>;
  };
}

// ─── Module Variables ──────────────────────────────────────────────────────

export type VariableType = "number" | "boolean" | "text";

/**
 * Where a variable lives (see docs/learning-os.md §3):
 * - "module"  (default): one session, then gone — held in module_sessions.variable_state.
 * - "learner": durable per-learner across every module — held in learner_state,
 *   read in at module start and written back on emit.setVariable. This is what
 *   lets a score earned in module A gate or feed module B.
 */
export type VariableScope = "module" | "learner";

export interface VariableDefinition {
  id: string;
  name: string;
  type: VariableType;
  initialValue: number | boolean | string;
  description?: string;
  visible?: boolean; // When true, shown to the learner as a HUD overlay
  /** Computed variables derive their value from a formula instead of actions */
  computed?: boolean;
  /** Arithmetic over other (non-computed) variable names, e.g. "correct / total * 100" */
  formula?: string;
  /** Lifetime/scope. Omitted = "module" (back-compatible with all existing vars). */
  scope?: VariableScope;
}

export type VariableOperator =
  | "set"
  | "increment"
  | "decrement"
  | "multiply"
  | "divide"
  | "set_true"
  | "set_false"
  | "toggle";

export interface VariableAction {
  variableId: string;
  operator: VariableOperator;
  value?: number | string;
}

export type TriggerType =
  | "onNodeEnter"
  | "onNodeExit"
  | "onTimerElapsed"
  | "onVideoComplete"
  | "onVideoTimestamp";

export interface NodeTrigger {
  type: TriggerType;
  actions: VariableAction[];
  config?: {
    duration?: number;   // seconds — for onTimerElapsed
    timestamp?: number;  // seconds — for onVideoTimestamp
  };
}

// ─── Timers ─────────────────────────────────────────────────────────────────
// A visible game-style timer. Lives on a node (config.timer), a scene (same
// field — scenes are nodes), or the whole module (ModuleSettings.timer).
// Distinct from the silent onTimerElapsed trigger: a TimerConfig shows an
// on-screen clock, supports count-up (stopwatch) as well as countdown, and can
// route/finish on expiry — not just fire variable actions. v1 timers are
// session-ephemeral (they start when the learner reaches the node / the module
// loads); persistent deadlines are deferred to the formal-assessment work.

/** What navigation does when a countdown hits zero. */
export type TimerExpireBehavior =
  | "none" // just fire actions / record, stay put
  | "advance" // go to the next node (node/scene scope)
  | "route" // jump to a specific node
  | "end"; // finish the module

export interface TimerConfig {
  /** countdown = pressure (ticks down to zero); countup = stopwatch (measures elapsed) */
  mode: "countdown" | "countup";
  /** countdown only: the limit in seconds */
  seconds?: number;
  /** Show the on-screen clock. Default true — the visible clock IS the pressure. */
  visible?: boolean;
  /** Optional caption shown next to the clock, e.g. "Time remaining" */
  label?: string;
  /** countdown only: clock turns red and pulses when remaining ≤ this (default 10) */
  warnAtSeconds?: number;
  /** Play a soft tick near zero + a buzzer on expiry (default true) */
  sound?: boolean;
  /** countdown only: what happens when time runs out */
  onExpire?: {
    behavior?: TimerExpireBehavior;
    /** for behavior "route" */
    targetNodeId?: string;
    /** variable actions to fire on expiry (same shape as hotspots/triggers) */
    actions?: VariableAction[];
  };
  /** Write the elapsed whole seconds to this number variable when the learner
      leaves (count-up) or when the countdown ends. "How long did this take." */
  recordVariableId?: string;
}

// ─── Completion / pass-fail ─────────────────────────────────────────────────
// How a module decides whether the learner passed. "Passing" is creator-
// defined — any variable, not just a score (a competency level, a safety flag,
// mistakes under a cap), or simply reaching a designated ending node.

export type CompletionOperator =
  | ">="
  | ">"
  | "<="
  | "<"
  | "=="
  | "!="
  | "contains"
  | "is_true"
  | "is_false";

export interface CompletionRule {
  /**
   * "variable" = compare a variable; "reachedNode" = passed if they reached a
   * node; "nodeScore" = compare nodes' own emitted scores (no variable wiring
   * needed — the node↔OS contract records each node's score on its result).
   * Default "variable".
   */
  mode?: "variable" | "reachedNode" | "nodeScore";
  /** variable mode: which variable decides passing (any type, not just score) */
  variableId?: string;
  operator?: CompletionOperator;
  /** comparison value (omitted for is_true/is_false) */
  value?: number | string;
  /** reachedNode mode: passed once the learner reaches this node */
  passNodeId?: string;
  /**
   * nodeScore mode: compare a single node's score by id. Omit to compare an
   * aggregate across every node that emitted a score this run.
   */
  scoreNodeId?: string;
  /**
   * nodeScore mode: how to combine all scored nodes when scoreNodeId is unset.
   * Default "average" (e.g. "average node score ≥ 70").
   */
  scoreAggregate?: "average" | "total" | "min" | "max";
  /** Award a certificate when the learner passes (issuing wired in Phase 2) */
  certificate?: boolean;
  /**
   * How long an awarded certificate stays valid, in months. Unset = never
   * expires. Stamped onto certificates.expires_at SERVER-SIDE at issue
   * (issue_certificate_for reads this rule from the stored module content) —
   * compliance training norms are 12 (annual) or 36 (3-yearly refresher).
   */
  certificateValidityMonths?: number;
}

// ─── Module-level settings ──────────────────────────────────────────────────
// Globals that aren't tied to a single node. Stored at module.content.settings.

export interface ModuleSettings {
  /** Whole-module timer (e.g. "finish the simulation in 10 minutes") */
  timer?: TimerConfig;
  /** How the module decides pass/fail (drives the result screen + certificates) */
  completion?: CompletionRule;
}

// ─── Nodes ────────────────────────────────────────────────────────────────

export interface Node {
  id: string;
  type:
    | "message"
    | "video"
    | "choice"
    | "textInput"
    | "multipleChoice"
    | "ranking"
    | "matching"
    | "rating"
    | "condition"
    | "scene" // immersive environment with hotspots (Stage 2)
    | "conversation" // learner chats with an AI character (Stage 2 Phase 4)
    | "code" // creator/AI-authored behaviour via the Code Node SDK (sandboxed)
    | "note"; // canvas-only annotation — never shown to learners
  position: Point;
  title: string;
  connection?: string; // Single connection for non-router nodes
  color: string;
  config: NodeConfig;
}
