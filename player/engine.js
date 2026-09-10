// The .ronu runtime, with no DOM: graph walking, variables, actions,
// conditions, timers, scoring, and the session event log.
//
// Written from spec/ronu-spec.md. Everything the spec left unsaid and the
// choice made here is listed in player/SPEC-GAPS.md (entries referenced as
// G<n> in comments below).

import { evaluateFormula } from './formula.js';
import { evaluateConditionConfig, compareCompletion } from './conditions.js';

// Spec section 8: legacy node types readers must still accept.
const LEGACY_TYPES = { router: 'choice', decisionPath: 'condition' };

// Spec section 7 tags.
export const STABLE_TYPES = new Set([
  'message', 'video', 'choice', 'textInput', 'multipleChoice', 'ranking',
  'matching', 'rating', 'condition', 'note', 'scene',
]);
export const PROVISIONAL_TYPES = new Set(['procedure', 'dragToTarget', 'conversation', 'code']);

// What this player renders itself. Anything else gets the section 5.2 fallback.
export const IMPLEMENTED_TYPES = new Set([...STABLE_TYPES, 'procedure', 'dragToTarget']);
const STABLE_SCENE_KINDS = new Set(['photo360', 'photo2d']);
// Spec section 7.2: the types a scene hotspot's `interaction` may nest. The
// routing types (choice, condition) are deliberately absent.
export const NESTABLE_TYPES = new Set(['message', 'multipleChoice', 'textInput', 'matching', 'ranking', 'rating', 'procedure', 'dragToTarget']);

export const DEFAULT_DISCOVERY_RADIUS_360 = 0.35; // radians, great-circle (G10)
export const DEFAULT_DISCOVERY_RADIUS_2D = 0.08; // fraction of the image (G10)
export const DEFAULT_TIMER_TRIGGER_SECONDS = 30; // onTimerElapsed without config.duration (G8)
const MAX_PASSTHROUGH_HOPS = 200; // guards a note/condition cycle

export function normalizeType(type) {
  const t = typeof type === 'string' ? type : '';
  return LEGACY_TYPES[t] ?? t;
}

/** Canonical `config.criteria` object, or the legacy stringified `config.choices`. */
export function parseConditionConfig(config) {
  if (!config || typeof config !== 'object') return null;
  if (config.criteria && typeof config.criteria === 'object') return config.criteria;
  if (typeof config.choices === 'string') {
    try {
      const parsed = JSON.parse(config.choices);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  if (config.choices && typeof config.choices === 'object' && !Array.isArray(config.choices)) return config.choices;
  return null;
}

/** Can this player render the node itself, or does it fall back? */
export function isNodeSupported(node) {
  const type = normalizeType(node?.type);
  if (!IMPLEMENTED_TYPES.has(type)) return false;
  if (type === 'scene') {
    const kind = node?.config?.environment?.kind;
    // A scene with no environment at all is still playable (hotspots on a blank backdrop).
    return kind == null || kind === '' || STABLE_SCENE_KINDS.has(kind);
  }
  return true;
}

const DEFAULTS = { number: 0, boolean: false, text: '' };

function coerce(type, value) {
  if (type === 'number') {
    const n = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (type === 'boolean') {
    if (typeof value === 'string') return ['true', 'yes', '1'].includes(value.trim().toLowerCase());
    return Boolean(value);
  }
  if (type === 'text') return value == null ? '' : String(value);
  return value;
}

// Deterministic shuffle so a procedure's displayed order is stable per node.
function seededShuffle(list, seedText) {
  let seed = 2166136261;
  for (const ch of String(seedText)) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function angularDistance(a, b) {
  const cos = Math.sin(a.pitch) * Math.sin(b.pitch) + Math.cos(a.pitch) * Math.cos(b.pitch) * Math.cos(a.yaw - b.yaw);
  return Math.acos(Math.max(-1, Math.min(1, cos)));
}

export class Engine {
  /**
   * @param {object} module   parsed module.json
   * @param {object} [opts]
   * @param {() => number} [opts.now]   clock in ms (injectable for tests)
   * @param {object} [opts.services]   { conversation: boolean }: a receiver is connected
   *   (docs/record-receiver.md section 4), so `conversation` nodes play live instead of falling back
   */
  constructor(module, opts = {}) {
    if (!module || typeof module !== 'object' || !Array.isArray(module.nodes)) {
      throw new Error('module.json must be an object with a nodes array');
    }
    this.module = module;
    this.now = opts.now ?? (() => Date.now());
    this.services = { conversation: Boolean(opts.services?.conversation) };
    this.nodes = module.nodes.filter((n) => n && typeof n === 'object');
    this.nodesById = new Map();
    for (const n of this.nodes) if (typeof n.id === 'string' && n.id !== '' && !this.nodesById.has(n.id)) this.nodesById.set(n.id, n);
    this.variableDefs = (Array.isArray(module.variables) ? module.variables : []).filter((v) => v && typeof v === 'object');
    this.settings = module.settings && typeof module.settings === 'object' ? module.settings : {};

    this.revision = 0;
    this.events = [];
    this.reset();
  }

  reset() {
    this.values = {};
    for (const v of this.variableDefs) {
      if (v.computed) continue;
      const type = v.type;
      const init = v.initialValue === undefined || v.initialValue === null ? DEFAULTS[type] : v.initialValue;
      this.values[v.id] = coerce(type, init);
    }
    this.responses = {};
    this.nodeScores = {};
    this.visited = new Set();
    this.trail = [];
    this.currentNodeId = null;
    this.nodeState = null;
    this.nodeTimer = null;
    this.timerTrigger = null;
    this.moduleTimer = null;
    this.started = false;
    this.ended = false;
    this.result = null;
    this.error = null;
    this.hops = 0;
  }

  // ---- lifecycle ----------------------------------------------------------

  start() {
    this.reset();
    this.events = [];
    this.started = true;
    this.startedAt = this.now();
    this.record('launched', {});
    const timer = this.settings.timer;
    if (timer && typeof timer === 'object' && timer.mode) {
      this.moduleTimer = { config: timer, startedAt: this.now(), fired: false, expired: false };
    }
    const start = this.nodes.find((n) => n.config && n.config.isStart === true) ?? this.nodes[0];
    if (!start || typeof start.id !== 'string') {
      this.finish('no-start');
      return this.view();
    }
    this.hops = 0;
    this.enterNode(start.id);
    return this.view();
  }

  bump() {
    this.revision += 1;
  }

  /** Turn receiver-backed services on or off mid-play (a connection made or dropped). */
  setServices(services) {
    this.services = { ...this.services, ...(services ?? {}) };
    this.bump();
  }

  /** isNodeSupported, plus `conversation` while a receiver provides the character. */
  nodeSupported(node) {
    if (isNodeSupported(node)) return true;
    return normalizeType(node?.type) === 'conversation' && this.services.conversation;
  }

  record(type, data) {
    this.events.push({ at: this.now(), seq: this.events.length, type, ...data });
  }

  get currentNode() {
    return this.currentNodeId ? this.nodesById.get(this.currentNodeId) ?? null : null;
  }

  enterNode(id) {
    if (this.ended) return;
    const node = this.nodesById.get(id);
    if (!node) {
      // Spec section 5.2 tolerance: a dangling edge ends the experience rather than crashing.
      this.error = `Connection points at a node that does not exist: ${id}`;
      this.finish('dangling');
      return;
    }
    if (++this.hops > MAX_PASSTHROUGH_HOPS) {
      this.error = 'The module loops through pass-through nodes without stopping.';
      this.finish('loop');
      return;
    }
    const type = normalizeType(node.type);
    const cfg = node.config && typeof node.config === 'object' ? node.config : {};
    this.currentNodeId = id;
    this.enteredAt = this.now();
    this.nodeState = this.initialNodeState(node, type, cfg);
    this.nodeTimer = null;
    this.timerTrigger = null;

    // Spec section 7 `note`: never part of the flow.
    if (type === 'note') {
      this.record('skipped', { nodeId: id, reason: 'note' });
      this.advance(node.connection, { silent: true });
      return;
    }

    this.visited.add(id);
    this.trail.push(id);
    this.record('entered', { nodeId: id, nodeType: node.type });
    this.fireTriggers(node, 'onNodeEnter');

    if (cfg.timer && typeof cfg.timer === 'object' && cfg.timer.mode) {
      this.nodeTimer = { config: cfg.timer, startedAt: this.now(), fired: false, expired: false };
    }
    const elapsedTrigger = (Array.isArray(cfg.triggers) ? cfg.triggers : []).find((t) => t && t.type === 'onTimerElapsed');
    if (elapsedTrigger) {
      const seconds = Number(elapsedTrigger.config?.duration ?? elapsedTrigger.config?.seconds ?? DEFAULT_TIMER_TRIGGER_SECONDS);
      this.timerTrigger = { trigger: elapsedTrigger, dueAt: this.now() + (Number.isFinite(seconds) ? seconds : DEFAULT_TIMER_TRIGGER_SECONDS) * 1000, fired: false };
    }

    // Condition nodes route immediately and are never shown.
    if (type === 'condition') {
      const target = evaluateConditionConfig(parseConditionConfig(cfg), (field) => this.resolveField(field));
      this.record('branch', { nodeId: id, targetNodeId: target ?? node.connection ?? null });
      this.advance(target ?? node.connection ?? null);
      return;
    }
    this.hops = 0;
    this.bump();
  }

  initialNodeState(node, type, cfg) {
    const state = { answered: false, feedback: null };
    if (type === 'scene') {
      state.visited = [];
      state.found = [];
      state.beat = null; // {kind: 'conversation'|'interaction'|'reveal', hotspotId, then: []}
      state.misses = 0;
      state.lastTap = null;
      state.interactions = {}; // hotspot id -> the nested interaction's own node state (section 7.2)
      state.conversations = {}; // hotspot id -> {answered, fallback} for a live character (record-receiver section 4)
    } else if (type === 'conversation') {
      state.fallback = false; // the live character failed and the learner took the fallback card
    } else if (type === 'procedure') {
      const steps = Array.isArray(cfg.procedureSteps) ? cfg.procedureSteps : [];
      state.order = seededShuffle(steps.map((_, i) => i), node.id);
      state.performed = [];
      state.missteps = [];
      state.halted = false;
      state.note = null;
    } else if (type === 'dragToTarget') {
      state.placements = {};
    }
    return state;
  }

  /** Leave the current node along `targetId` (null = the experience ends). */
  advance(targetId, opts = {}) {
    if (this.ended) return;
    const node = this.currentNode;
    if (node && !opts.silent) {
      this.fireTriggers(node, 'onNodeExit');
      this.recordTimerVariable(this.nodeTimer, this.now());
      this.record('exited', { nodeId: node.id, targetNodeId: targetId ?? null });
    }
    this.nodeTimer = null;
    this.timerTrigger = null;
    this.nodeState = null;
    if (typeof targetId === 'string' && targetId !== '') this.enterNode(targetId);
    else this.finish('end');
  }

  finish(reason) {
    if (this.ended) return;
    this.ended = true;
    this.recordTimerVariable(this.moduleTimer, this.now());
    this.currentNodeId = null;
    this.nodeState = null;
    this.result = this.evaluateCompletion();
    this.result.reason = reason;
    this.record('completed', { passed: this.result.passed, score: this.result.score, reason });
    this.bump();
  }

  // ---- variables ----------------------------------------------------------

  findVariable(idOrName) {
    if (typeof idOrName !== 'string') return null;
    return this.variableDefs.find((v) => v.id === idOrName) ?? this.variableDefs.find((v) => v.name === idOrName) ?? null;
  }

  valuesByName() {
    const out = {};
    for (const v of this.variableDefs) if (!v.computed && typeof v.name === 'string') out[v.name] = this.values[v.id];
    return out;
  }

  getValue(def) {
    if (!def) return undefined;
    if (def.computed) return evaluateFormula(def.formula ?? '', this.valuesByName());
    return this.values[def.id];
  }

  /** Snapshot of every variable for display and the end screen. */
  variables() {
    return this.variableDefs.map((v) => ({
      id: v.id, name: v.name, type: v.type, visible: v.visible !== false, computed: Boolean(v.computed), value: this.getValue(v),
    }));
  }

  /** Spec section 7 VariableAction. */
  applyActions(actions, source) {
    if (!Array.isArray(actions)) return;
    for (const a of actions) {
      if (!a || typeof a !== 'object') continue;
      const def = this.findVariable(a.variableId);
      if (!def || def.computed) continue;
      const before = this.values[def.id];
      const type = def.type;
      let next = before;
      switch (a.operator) {
        case 'set':
          next = coerce(type, a.value);
          break;
        case 'increment':
          next = coerce('number', before) + coerce('number', a.value ?? 1);
          break;
        case 'decrement':
          next = coerce('number', before) - coerce('number', a.value ?? 1);
          break;
        case 'multiply':
          next = coerce('number', before) * coerce('number', a.value ?? 1);
          break;
        case 'divide': {
          const d = coerce('number', a.value);
          next = d === 0 ? coerce('number', before) : coerce('number', before) / d;
          break;
        }
        case 'set_true':
          next = true;
          break;
        case 'set_false':
          next = false;
          break;
        case 'toggle':
          next = !coerce('boolean', before);
          break;
        default:
          continue; // must-ignore: unknown operator
      }
      if (type === 'number' || type === 'boolean' || type === 'text') next = coerce(type, next);
      if (next !== before) {
        this.values[def.id] = next;
        this.record('variable', { variableId: def.id, name: def.name, from: before, to: next, source: source ?? null });
      }
    }
  }

  fireTriggers(node, type) {
    const triggers = node?.config?.triggers;
    if (!Array.isArray(triggers)) return;
    for (const t of triggers) if (t && t.type === type) this.applyActions(t.actions, `trigger:${type}`);
  }

  /** Spec section 7: `{variableName}` placeholders substituted at play time. */
  substitute(text) {
    if (typeof text !== 'string' || !text.includes('{')) return text ?? '';
    return text.replace(/\{([A-Za-z0-9_]+)\}/g, (m, name) => {
      const def = this.variableDefs.find((v) => v.name === name);
      if (!def) return m;
      const v = this.getValue(def);
      return v === undefined || v === null ? '' : String(v);
    });
  }

  // ---- conditions ---------------------------------------------------------

  /** A condition `field` is a variable id (or name), else a node id whose recorded answer is compared (G2). */
  resolveField(field) {
    const def = this.findVariable(field);
    if (def) return { value: this.getValue(def) };
    const r = this.responses[field];
    if (!r) return { value: undefined };
    return { value: r.response, texts: r.texts ?? null };
  }

  // ---- completion ---------------------------------------------------------

  evaluateCompletion() {
    const rule = this.settings.completion;
    const out = { passed: null, score: null, rule: rule ?? null };
    const scores = Object.values(this.nodeScores);
    if (scores.length) out.score = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    if (!rule || typeof rule !== 'object') return out;
    const mode = rule.mode ?? 'variable';
    if (mode === 'reachedNode') {
      out.passed = Boolean(rule.passNodeId) && this.visited.has(rule.passNodeId);
    } else if (mode === 'nodeScore') {
      let value;
      if (rule.scoreNodeId) value = this.nodeScores[rule.scoreNodeId];
      else if (scores.length) {
        const agg = rule.scoreAggregate ?? 'average';
        if (agg === 'min') value = Math.min(...scores);
        else if (agg === 'max') value = Math.max(...scores);
        else if (agg === 'sum') value = scores.reduce((a, b) => a + b, 0);
        else value = scores.reduce((a, b) => a + b, 0) / scores.length;
      }
      out.score = value === undefined ? out.score : Math.round(value);
      out.passed = value === undefined ? false : (rule.operator ? compareCompletion(value, rule.operator, rule.value) : value >= (Number(rule.value) || 0));
    } else {
      const def = this.findVariable(rule.variableId);
      if (def && rule.operator) out.passed = compareCompletion(this.getValue(def), rule.operator, rule.value);
      if (def && typeof this.getValue(def) === 'number' && out.score === null) out.score = this.getValue(def);
    }
    return out;
  }

  // ---- timers -------------------------------------------------------------

  timerView(t, nowMs) {
    if (!t) return null;
    const cfg = t.config;
    const elapsed = Math.max(0, (nowMs - t.startedAt) / 1000);
    const limit = Number(cfg.seconds) || 0;
    const countdown = cfg.mode === 'countdown';
    const remaining = countdown ? Math.max(0, limit - elapsed) : 0;
    const warnAt = cfg.warnAtSeconds ?? 10;
    return {
      mode: cfg.mode, label: cfg.label ?? '', visible: cfg.visible !== false, elapsed: Math.floor(elapsed), remaining: Math.ceil(remaining),
      display: countdown ? Math.ceil(remaining) : Math.floor(elapsed), expired: t.expired, warning: countdown && remaining > 0 && remaining <= warnAt,
    };
  }

  recordTimerVariable(t, nowMs) {
    if (!t || !t.config.recordVariableId) return;
    const elapsed = Math.round((nowMs - t.startedAt) / 1000);
    this.applyActions([{ variableId: t.config.recordVariableId, operator: 'set', value: elapsed }], 'timer:record');
  }

  /**
   * Advance the clock. Call every ~250ms from the UI (or with a fake clock in
   * tests). Returns true when something other than the displayed time changed.
   */
  tick() {
    if (!this.started || this.ended) return false;
    const nowMs = this.now();
    const before = this.revision;

    if (this.timerTrigger && !this.timerTrigger.fired && nowMs >= this.timerTrigger.dueAt) {
      this.timerTrigger.fired = true;
      this.applyActions(this.timerTrigger.trigger.actions, 'trigger:onTimerElapsed');
      this.record('trigger', { nodeId: this.currentNodeId, type: 'onTimerElapsed' });
      this.bump();
      if (this.checkAbort()) return true; // actions fired inside a scene re-evaluate abortWhen
    }

    const nodeTimer = this.nodeTimer;
    if (nodeTimer && this.timerDue(nodeTimer, nowMs)) {
      nodeTimer.fired = true;
      nodeTimer.expired = true;
      const node = this.currentNode;
      const onExpire = nodeTimer.config.onExpire ?? {};
      this.record('timer-expiry', { scope: 'node', nodeId: node?.id ?? null, behavior: onExpire.behavior ?? 'none' });
      this.applyActions(onExpire.actions, 'timer:node');
      this.bump();
      if (this.checkAbort()) return true;
      if (onExpire.behavior === 'advance') this.advance(node?.connection ?? null);
      else if (onExpire.behavior === 'route') this.advance(onExpire.targetNodeId || node?.connection || null);
      else if (onExpire.behavior === 'end') this.finish('timer');
      if (this.ended) return true;
    }

    const mt = this.moduleTimer;
    if (mt && this.timerDue(mt, nowMs)) {
      mt.fired = true;
      mt.expired = true;
      const onExpire = mt.config.onExpire ?? {};
      this.record('timer-expiry', { scope: 'module', behavior: onExpire.behavior ?? 'none' });
      this.applyActions(onExpire.actions, 'timer:module');
      this.bump();
      if (onExpire.behavior === 'route') this.advance(onExpire.targetNodeId || null);
      else if (onExpire.behavior === 'end' || onExpire.behavior === 'advance') this.finish('timer');
    }
    return this.revision !== before;
  }

  timerDue(t, nowMs) {
    if (t.fired || t.config.mode !== 'countdown') return false;
    const limit = Number(t.config.seconds);
    if (!(limit > 0)) return false;
    return (nowMs - t.startedAt) / 1000 >= limit;
  }

  // ---- answers ------------------------------------------------------------

  requireNode(type) {
    const node = this.currentNode;
    if (!node) throw new Error('No current node');
    const t = normalizeType(node.type);
    if (type && t !== type) throw new Error(`Current node is ${t}, not ${type}`);
    return node;
  }

  /**
   * What an answer call applies to: the current node or, while a scene's
   * interaction beat is open, that hotspot's nested sub-node (section 7.2).
   * Returns `{node, st, scene, hotspot}`; `scene` and `hotspot` are null at
   * the top level.
   */
  answerTarget(type) {
    const node = this.currentNode;
    if (!node) throw new Error('No current node');
    let target = { node, st: this.nodeState, scene: null, hotspot: null };
    const st = this.nodeState;
    if (normalizeType(node.type) === 'scene' && st.beat?.kind === 'interaction') {
      const hotspot = this.sceneHotspots(node).find((h) => h.id === st.beat.hotspotId);
      const sub = hotspot ? this.hotspotInteraction(node, hotspot) : null;
      if (sub) target = { node: sub, st: this.interactionState(node, hotspot), scene: node, hotspot };
    }
    const t = normalizeType(target.node.type);
    if (type && t !== type) throw new Error(`Current node is ${t}, not ${type}`);
    return target;
  }

  /** Record an answer against `target` (see answerTarget). A nested answer is keyed `<sceneId>/<hotspotId>`. */
  recordAnswer(target, response, extra = {}) {
    const { node, st, scene, hotspot } = target;
    const entry = { response, ...extra };
    this.responses[node.id] = entry;
    if (typeof extra.score === 'number') this.nodeScores[node.id] = extra.score;
    st.answered = true;
    this.record('answered', {
      nodeId: scene ? scene.id : node.id, hotspotId: hotspot ? hotspot.id : null, subNodeId: scene ? node.id : null,
      response, texts: extra.texts ?? null, score: typeof extra.score === 'number' ? extra.score : null,
    });
    this.bump();
  }

  /** After an answer: a top-level node may advance on answer; a nested one never routes but may trip `abortWhen`. */
  afterAnswer(target) {
    if (target.scene) {
      this.checkAbort();
      return;
    }
    if (target.node.config?.advanceOnAnswer) this.advance(this.defaultTarget(target.node));
  }

  /** Default forward edge: the node's `connection` (config.connection as a legacy fallback, G17). */
  defaultTarget(node) {
    if (typeof node.connection === 'string' && node.connection !== '') return node.connection;
    if (typeof node.config?.connection === 'string' && node.config.connection !== '') return node.config.connection;
    return null;
  }

  canContinue() {
    const node = this.currentNode;
    if (!node) return false;
    const type = normalizeType(node.type);
    const cfg = node.config ?? {};
    const st = this.nodeState;
    if (type === 'scene') {
      if (st.beat) return false;
      if (cfg.completion === 'allRequired') {
        const required = this.sceneHotspots(node).filter((h) => h.required);
        return required.every((h) => this.hotspotSatisfied(node, h));
      }
      return true;
    }
    if (type === 'choice') return false;
    // A live conversation must be ended (assessed) or given up on before the learner moves on.
    if (type === 'conversation') return !this.services.conversation || st.answered || st.fallback;
    if (type === 'procedure' || type === 'dragToTarget') return st.answered;
    if (['textInput', 'multipleChoice', 'ranking', 'matching', 'rating'].includes(type)) {
      return st.answered || cfg.required !== true;
    }
    return true;
  }

  /** Follow the default connection. */
  continue() {
    const node = this.requireNode();
    if (!this.canContinue()) return this.view();
    this.advance(this.defaultTarget(node));
    return this.view();
  }

  /** choice: the branching primitive. */
  choose(choiceId) {
    const node = this.requireNode('choice');
    const choices = Array.isArray(node.config?.choices) ? node.config.choices : [];
    const choice = choices.find((c) => c && c.id === choiceId) ?? choices.find((c) => c && c.text === choiceId);
    if (!choice) throw new Error(`Unknown choice ${choiceId}`);
    this.recordAnswer({ node, st: this.nodeState, scene: null, hotspot: null }, choice.id ?? choice.text, { texts: [choice.text ?? ''] });
    this.applyActions(choice.actions, `choice:${choice.id}`);
    this.advance(choice.connection || this.defaultTarget(node));
    return this.view();
  }

  // Each answer method below works on the current node or, while a scene's
  // interaction beat is open, on the nested sub-node (see answerTarget).

  answerText(text) {
    const target = this.answerTarget('textInput');
    this.recordAnswer(target, String(text ?? ''));
    this.afterAnswer(target);
    return this.view();
  }

  answerMultiple(choiceIds) {
    const target = this.answerTarget('multipleChoice');
    const { node } = target;
    const choices = Array.isArray(node.config?.choices) ? node.config.choices : [];
    const ids = (Array.isArray(choiceIds) ? choiceIds : [choiceIds]).filter((id) => choices.some((c) => c && c.id === id));
    const picked = ids.map((id) => choices.find((c) => c.id === id));
    if (node.config?.allowMultiple !== true && picked.length > 1) picked.length = 1;
    this.recordAnswer(target, picked.map((c) => c.id), { texts: picked.map((c) => c.text ?? '') });
    for (const c of picked) this.applyActions(c.actions, `choice:${c.id}`);
    this.afterAnswer(target);
    return this.view();
  }

  answerRanking(orderedItems) {
    const target = this.answerTarget('ranking');
    const items = Array.isArray(target.node.config?.rankingItems) ? target.node.config.rankingItems : [];
    const labels = items.map((it) => (typeof it === 'string' ? it : it?.text ?? it?.label ?? String(it?.id ?? '')));
    const order = (Array.isArray(orderedItems) ? orderedItems : []).map(String).filter((s) => labels.includes(s));
    for (const l of labels) if (!order.includes(l)) order.push(l);
    this.recordAnswer(target, order);
    this.afterAnswer(target);
    return this.view();
  }

  /** matching: `matches` is left id -> right id. */
  answerMatching(matches) {
    const target = this.answerTarget('matching');
    const { node, st } = target;
    const left = Array.isArray(node.config?.matchingLeftItems) ? node.config.matchingLeftItems : [];
    const graded = node.config?.matchingGraded !== false;
    const map = matches && typeof matches === 'object' ? { ...matches } : {};
    const scorable = left.filter((l) => l && l.correctRightId);
    let correct = 0;
    const perItem = {};
    for (const l of left) {
      if (!l || !l.id) continue;
      const ok = Boolean(l.correctRightId) && map[l.id] === l.correctRightId;
      perItem[l.id] = l.correctRightId ? ok : null;
      if (ok) {
        correct += 1;
        this.applyActions(l.actions, `match:${l.id}`); // fired per correct match (G15)
      }
    }
    const extra = { feedback: graded ? { perItem, correct, total: scorable.length } : null };
    if (graded && scorable.length > 0) extra.score = Math.round((correct / scorable.length) * 100);
    this.recordAnswer(target, map, extra);
    st.feedback = extra.feedback;
    this.afterAnswer(target);
    return this.view();
  }

  answerRating(value) {
    const target = this.answerTarget('rating');
    const { node } = target;
    const n = Number(value);
    const min = Number(node.config?.ratingMin ?? 1);
    const max = Number(node.config?.ratingMax ?? 5);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error('Rating out of range');
    this.recordAnswer(target, n);
    if (node.config?.ratingVariableId) this.applyActions([{ variableId: node.config.ratingVariableId, operator: 'set', value: n }], 'rating');
    this.afterAnswer(target);
    return this.view();
  }

  // ---- conversation (provisional; live only through a receiver) ----------

  /**
   * The assessment of a live conversation (record-receiver section 4): the
   * node's answer is the transcript plus the assessment, its score is the
   * node score, and `scoreVariableId` is written with a `set` action.
   */
  answerConversation({ messages, assessment }) {
    const target = this.answerTarget('conversation');
    if (target.st.answered) return this.view();
    const score = Number(assessment?.score);
    const extra = Number.isFinite(score) ? { score: Math.max(0, Math.min(100, Math.round(score))) } : {};
    this.recordAnswer(target, { messages: Array.isArray(messages) ? messages : [], assessment: assessment ?? null }, extra);
    const varId = target.node.config?.scoreVariableId;
    if (varId && extra.score !== undefined) this.applyActions([{ variableId: varId, operator: 'set', value: extra.score }], 'conversation');
    this.afterAnswer(target);
    return this.view();
  }

  /** The live character failed; the learner takes the spec's fallback card and may continue. */
  conversationFallback() {
    const target = this.answerTarget('conversation');
    target.st.fallback = true;
    this.bump();
    return this.view();
  }

  /**
   * The same for a hotspot's `conversation` block inside a scene: recorded
   * against `<sceneId>/<hotspotId>` (as a nested interaction is, G45), the
   * score variable written, then `abortWhen` re-checked.
   */
  answerHotspotConversation(hotspotId, { messages, assessment }) {
    const node = this.requireNode('scene');
    const hotspot = this.sceneHotspots(node).find((h) => h.id === hotspotId);
    if (!hotspot || !hotspot.conversation) throw new Error(`Unknown hotspot conversation ${hotspotId}`);
    const st = this.nodeState;
    const cst = (st.conversations[hotspotId] ??= { answered: false, fallback: false });
    if (cst.answered) return this.view();
    const score = Number(assessment?.score);
    const extra = Number.isFinite(score) ? { score: Math.max(0, Math.min(100, Math.round(score))) } : {};
    const sub = { id: `${node.id}/${hotspot.id}` };
    this.recordAnswer({ node: sub, st: cst, scene: node, hotspot }, { messages: Array.isArray(messages) ? messages : [], assessment: assessment ?? null }, extra);
    const varId = hotspot.conversation.scoreVariableId;
    if (varId && extra.score !== undefined) this.applyActions([{ variableId: varId, operator: 'set', value: extra.score }], 'conversation');
    this.checkAbort();
    return this.view();
  }

  hotspotConversationFallback(hotspotId) {
    const node = this.requireNode('scene');
    const cst = (this.nodeState.conversations[hotspotId] ??= { answered: false, fallback: false });
    cst.fallback = true;
    this.bump();
    return this.view();
  }

  /** The state of a hotspot's live conversation, or null when the receiver is not providing one. */
  hotspotConversationState(hotspotId) {
    if (!this.services.conversation) return null;
    const st = this.nodeState;
    if (!st || !st.conversations) return null;
    return st.conversations[hotspotId] ?? { answered: false, fallback: false };
  }

  // ---- scene --------------------------------------------------------------

  sceneHotspots(node) {
    return (Array.isArray(node.config?.hotspots) ? node.config.hotspots : []).filter((h) => h && typeof h === 'object' && typeof h.id === 'string');
  }

  sceneKind(node) {
    const kind = node.config?.environment?.kind;
    return kind === 'photo2d' ? 'photo2d' : 'photo360';
  }

  /** In `hotspotSequence: "ordered"` a hotspot is locked until every earlier one is visited. */
  hotspotLocked(node, hotspot) {
    if (node.config?.hotspotSequence !== 'ordered') return false;
    const st = this.nodeState;
    for (const h of this.sceneHotspots(node)) {
      if (h.id === hotspot.id) return false;
      if (!st.visited.includes(h.id)) return true;
    }
    return false;
  }

  // ---- scene: nested interactions and the early exit (section 7.2) --------

  /**
   * A hotspot's `interaction` as a sub-node `{id, type, title, config}`, or
   * null when there is none or its type is not nestable. The id is
   * `<sceneId>/<hotspotId>`, which is also the key the answer is recorded under.
   */
  hotspotInteraction(node, hotspot) {
    const it = hotspot?.interaction;
    if (!it || typeof it !== 'object') return null;
    const type = normalizeType(it.type);
    if (!NESTABLE_TYPES.has(type)) return null; // routing and unknown types never nest (G12)
    const config = it.config && typeof it.config === 'object' ? it.config : {};
    return { id: `${node.id}/${hotspot.id}`, type, title: hotspot.label ?? '', config, connection: null, sceneId: node.id, hotspotId: hotspot.id };
  }

  /** The nested interaction's own node state, created on first use. Only meaningful while `node` is current. */
  interactionState(node, hotspot) {
    const sub = this.hotspotInteraction(node, hotspot);
    if (!sub) return null;
    const st = this.nodeState;
    if (!st.interactions[hotspot.id]) st.interactions[hotspot.id] = this.initialNodeState(sub, sub.type, sub.config);
    return st.interactions[hotspot.id];
  }

  /** Visited, and, when the hotspot carries an interaction, answered (section 7.2: dismissing is not enough). */
  hotspotSatisfied(node, hotspot) {
    const st = this.nodeState;
    if (!st || !Array.isArray(st.visited) || !st.visited.includes(hotspot.id)) return false;
    if (!this.hotspotInteraction(node, hotspot)) return true;
    return Boolean(st.interactions[hotspot.id]?.answered);
  }

  /** Does the scene's `abortWhen` rule hold right now? Same comparison as a completion rule; operator defaults to is_true. */
  abortHolds(node) {
    const rule = node.config?.abortWhen;
    if (!rule || typeof rule !== 'object') return false;
    if (typeof rule.targetNodeId !== 'string' || rule.targetNodeId === '') return false; // nowhere to go: never fires (the validator warns)
    const def = this.findVariable(rule.variableId);
    if (!def) return false;
    const operator = typeof rule.operator === 'string' && rule.operator.trim() !== '' ? rule.operator : 'is_true';
    return compareCompletion(this.getValue(def), operator, rule.value);
  }

  /**
   * Re-evaluate `abortWhen` after an action fired inside the scene. When it
   * holds, the learner leaves at once for `targetNodeId`. Returns true if so.
   */
  checkAbort() {
    const node = this.currentNode;
    if (!node || normalizeType(node.type) !== 'scene' || !this.abortHolds(node)) return false;
    const rule = node.config.abortWhen;
    this.nodeState.beat = null;
    this.record('scene-abort', { nodeId: node.id, variableId: rule.variableId, targetNodeId: rule.targetNodeId });
    this.advance(rule.targetNodeId);
    return true;
  }

  /** Tap a visible marker, or a hidden hotspot that `tapScene` just found. */
  activateHotspot(hotspotId) {
    const node = this.requireNode('scene');
    const st = this.nodeState;
    if (st.beat) return this.view();
    const hotspot = this.sceneHotspots(node).find((h) => h.id === hotspotId);
    if (!hotspot) throw new Error(`Unknown hotspot ${hotspotId}`);
    if (this.hotspotLocked(node, hotspot)) {
      st.lastTap = { kind: 'locked', hotspotId };
      this.bump();
      return this.view();
    }
    if (!st.visited.includes(hotspot.id)) {
      st.visited.push(hotspot.id);
      if (hotspot.hidden) st.found.push(hotspot.id);
      this.applyActions(hotspot.variableActions, `hotspot:${hotspot.id}`);
      this.record('hotspot', { nodeId: node.id, hotspotId: hotspot.id, label: hotspot.label ?? '' });
      if (this.checkAbort()) return this.view();
    }
    st.lastTap = { kind: 'hit', hotspotId };
    // Beats run in order: conversation (fallback card here), interaction, reveal, then the route (G12, section 7.2).
    const beats = [];
    if (hotspot.conversation && (hotspot.conversation.persona || hotspot.conversation.firstMessage)) beats.push('conversation');
    if (this.hotspotInteraction(node, hotspot)) {
      this.interactionState(node, hotspot);
      beats.push('interaction');
    }
    if (hotspot.reveal) beats.push('reveal');
    beats.push('route');
    st.beat = null;
    this.bump();
    this.runBeats(node, hotspot, beats);
    return this.view();
  }

  runBeats(node, hotspot, beats) {
    const st = this.nodeState;
    while (beats.length) {
      const b = beats.shift();
      if (b === 'route') {
        if (hotspot.targetNodeId) {
          this.advance(hotspot.targetNodeId);
          return;
        }
        continue;
      }
      st.beat = { kind: b, hotspotId: hotspot.id, then: beats };
      this.bump();
      return;
    }
  }

  /**
   * Dismiss the open card (reveal, conversation, or interaction) and run the
   * next beat. Closing an interaction that has not been answered puts the
   * learner back in the room and drops the later beats; they run once the
   * hotspot is opened again and answered (G41). A `message` interaction is
   * answered by reading it (the validator treats it as answerable).
   */
  dismissBeat() {
    const node = this.requireNode('scene');
    const st = this.nodeState;
    if (!st.beat) return this.view();
    const beat = st.beat;
    const hotspot = this.sceneHotspots(node).find((h) => h.id === beat.hotspotId);
    let rest = beat.then;
    if (beat.kind === 'conversation' && hotspot && this.services.conversation) {
      // A live character that has not been ended: closing returns to the room and the later beats wait, as for an interaction (G41).
      const cst = this.hotspotConversationState(hotspot.id);
      if (cst && !cst.answered && !cst.fallback) rest = [];
    }
    if (beat.kind === 'interaction' && hotspot) {
      const sub = this.hotspotInteraction(node, hotspot);
      const ist = sub ? this.interactionState(node, hotspot) : null;
      if (sub && ist && !ist.answered) {
        if (sub.type === 'message') {
          ist.answered = true;
          this.record('hotspot-read', { nodeId: node.id, hotspotId: hotspot.id });
        } else rest = [];
      }
    }
    st.beat = null;
    this.bump();
    if (hotspot) this.runBeats(node, hotspot, rest);
    return this.view();
  }

  /**
   * A tap on the scene itself (discovery). `point` is `{yaw, pitch}` in
   * radians for photo360, `{x, y}` as 0..1 fractions for photo2d (G10).
   * Returns the hotspot found, or null after a miss.
   */
  tapScene(point) {
    const node = this.requireNode('scene');
    const st = this.nodeState;
    if (st.beat) return null;
    const kind = this.sceneKind(node);
    const radius = Number(node.config?.discoveryRadius) || (kind === 'photo2d' ? DEFAULT_DISCOVERY_RADIUS_2D : DEFAULT_DISCOVERY_RADIUS_360);
    let best = null;
    let bestD = Infinity;
    for (const h of this.sceneHotspots(node)) {
      if (!h.hidden || st.visited.includes(h.id)) continue;
      const p = h.position ?? {};
      let d;
      if (kind === 'photo2d') {
        if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
        d = Math.hypot(point.x - p.x, point.y - p.y);
      } else {
        if (typeof p.yaw !== 'number') continue;
        d = angularDistance({ yaw: point.yaw, pitch: point.pitch ?? 0 }, { yaw: p.yaw, pitch: p.pitch ?? 0 });
      }
      if (d <= radius && d < bestD) {
        best = h;
        bestD = d;
      }
    }
    if (best) {
      if (this.hotspotLocked(node, best)) {
        st.lastTap = { kind: 'locked', hotspotId: best.id };
        this.bump();
        return null;
      }
      this.activateHotspot(best.id);
      return best;
    }
    st.misses += 1;
    st.lastTap = { kind: 'miss', point };
    this.applyActions(node.config?.missActions, 'scene:miss');
    this.record('scene-miss', { nodeId: node.id, point });
    this.bump();
    this.checkAbort();
    return null;
  }

  // ---- procedure (provisional) -------------------------------------------

  procedureSteps(node) {
    return (Array.isArray(node.config?.procedureSteps) ? node.config.procedureSteps : []).map((s, i) => (typeof s === 'string' ? { text: s, index: i } : { ...(s ?? {}), index: i }));
  }

  /** Perform step `index` (its index in the authored list). */
  performStep(index) {
    const target = this.answerTarget('procedure');
    const { node, st } = target;
    if (st.answered || st.halted) return this.view();
    const steps = this.procedureSteps(node);
    const step = steps[index];
    if (!step || st.performed.includes(index)) return this.view();
    const expected = steps.findIndex((s) => !st.performed.includes(s.index));
    const outOfTurn = index !== expected;
    st.performed.push(index);
    st.note = null;
    if (outOfTurn) {
      st.missteps.push(index);
      st.note = step.ifEarly || 'That is not the next thing to do.';
      this.applyActions(step.earlyActions, `procedure:early:${index}`);
      this.record('procedure-misstep', { ...this.eventIds(target), step: index, expected, critical: Boolean(step.critical) });
      if (step.critical && node.config?.procedureHaltOnCritical) st.halted = true;
    } else {
      this.record('procedure-step', { ...this.eventIds(target), step: index });
    }
    if (st.halted || st.performed.length === steps.length) {
      const inOrder = st.performed.length - st.missteps.length;
      const score = steps.length ? Math.round((inOrder / steps.length) * 100) : 100;
      this.recordAnswer(target, { order: st.performed.slice(), missteps: st.missteps.slice(), halted: st.halted }, { score });
    }
    this.bump();
    // Inside a scene, a step's earlyActions may have tripped abortWhen (section 7.2).
    if (target.scene) this.checkAbort();
    return this.view();
  }

  /** The node and hotspot ids an event carries for `target` (see answerTarget). */
  eventIds(target) {
    return { nodeId: target.scene ? target.scene.id : target.node.id, hotspotId: target.hotspot ? target.hotspot.id : null };
  }

  // ---- dragToTarget (provisional) ----------------------------------------

  /** Place an item on a target; `targetId` null removes it. */
  placeItem(itemId, targetId) {
    const { node, st } = this.answerTarget('dragToTarget');
    if (st.answered) return this.view();
    const items = Array.isArray(node.config?.dragItems) ? node.config.dragItems : [];
    const targets = Array.isArray(node.config?.dragTargets) ? node.config.dragTargets : [];
    if (!items.some((i) => i && i.id === itemId)) throw new Error(`Unknown item ${itemId}`);
    if (targetId != null && !targets.some((t) => t && t.id === targetId)) throw new Error(`Unknown target ${targetId}`);
    if (targetId == null) delete st.placements[itemId];
    else st.placements[itemId] = targetId;
    this.bump();
    return this.view();
  }

  submitPlacements() {
    const target = this.answerTarget('dragToTarget');
    const { node, st } = target;
    if (st.answered) return this.view();
    const items = (Array.isArray(node.config?.dragItems) ? node.config.dragItems : []).filter((i) => i && i.id);
    let correct = 0;
    const perItem = {};
    for (const it of items) {
      const placed = st.placements[it.id] ?? null;
      // A distractor (no targetId) is right only when left unused (spec section 7).
      const ok = it.targetId ? placed === it.targetId : placed === null;
      perItem[it.id] = ok;
      if (ok) correct += 1;
    }
    const score = items.length ? Math.round((correct / items.length) * 100) : 100;
    st.feedback = { perItem, correct, total: items.length };
    this.recordAnswer(target, { ...st.placements }, { score, feedback: st.feedback });
    return this.view();
  }

  // ---- view ---------------------------------------------------------------

  /** A plain description of what to render. */
  view() {
    const nowMs = this.now();
    const base = {
      revision: this.revision,
      variables: this.variables(),
      timers: { module: this.timerView(this.moduleTimer, nowMs), node: this.timerView(this.nodeTimer, nowMs) },
      error: this.error,
    };
    if (!this.started) return { kind: 'idle', ...base };
    if (this.ended) {
      return { kind: 'end', ...base, result: this.result, responses: this.responses, nodeScores: { ...this.nodeScores }, trail: this.trail.slice() };
    }
    const node = this.currentNode;
    const type = normalizeType(node.type);
    const cfg = node.config && typeof node.config === 'object' ? node.config : {};
    const supported = this.nodeSupported(node);
    const st = this.nodeState;
    return {
      kind: 'node',
      ...base,
      node,
      type,
      rawType: node.type,
      config: cfg,
      supported,
      services: { ...this.services },
      provisional: PROVISIONAL_TYPES.has(type) || (type === 'scene' && !STABLE_SCENE_KINDS.has(cfg.environment?.kind ?? 'photo360')),
      title: this.substitute(cfg.title ?? node.title ?? ''),
      question: this.substitute(cfg.question ?? ''),
      instructions: this.substitute(cfg.instructions ?? ''),
      content: this.substitute(cfg.content ?? ''),
      connection: this.defaultTarget(node),
      state: st,
      canContinue: this.canContinue(),
      // While a scene's interaction beat is open: the nested sub-node to render, in the same shape as this view.
      interaction: type === 'scene' && st.beat?.kind === 'interaction' ? this.interactionView(node, st.beat.hotspotId, st.beat.then) : null,
    };
  }

  /** The view of a hotspot's nested interaction (section 7.2): same shape as a node view, `nested: true`, never routes. */
  interactionView(node, hotspotId, then = []) {
    const hotspot = this.sceneHotspots(node).find((h) => h.id === hotspotId);
    const sub = hotspot ? this.hotspotInteraction(node, hotspot) : null;
    if (!sub) return null;
    const cfg = sub.config;
    return {
      kind: 'node',
      nested: true,
      hotspotId,
      node: sub,
      type: sub.type,
      rawType: sub.type,
      config: cfg,
      supported: true,
      provisional: PROVISIONAL_TYPES.has(sub.type),
      title: this.substitute(hotspot.label ?? cfg.title ?? ''),
      question: this.substitute(cfg.question ?? ''),
      instructions: this.substitute(cfg.instructions ?? ''),
      content: this.substitute(cfg.content ?? ''),
      connection: null,
      state: this.interactionState(node, hotspot),
      canContinue: false,
      then: then.slice(),
    };
  }
}
