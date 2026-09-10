// The conversation state machine (docs/record-receiver.md section 4): the
// transcript, one turn at a time through the receiver, the degraded stop,
// and the end-and-assess step that writes the score back into the engine.
//
// No DOM. The UI reads `status`, `messages`, `assessment`, `error`, `draft`
// and calls `send()` and `end()`; the receiver client is injected, so the
// whole loop runs in Node against a fake.
//
// Mirrors how the platform's own player drives a conversation: the
// character's `firstMessage` opens; each learner line is answered by one
// call carrying the full transcript; `degraded: true` ends the turn loop;
// "End conversation" (or the last allowed turn) finalises, the score goes to
// `scoreVariableId` with a `set` action, and the node's answer is recorded
// with that score so the session record (section 3) carries it.

export const DEFAULT_MAX_TURNS = 6; // the platform's default; the spec does not say (SPEC-GAPS G49)

export class ConversationRun {
  /**
   * @param {object} o
   * @param {object} o.config     the conversation node's config (or a hotspot's `conversation` block)
   * @param {string|null} o.moduleId
   * @param {ReceiverClient} o.client
   * @param {(run: ConversationRun) => void} [o.onChange]
   * @param {(assessment, messages) => void} [o.onAssessed]  fires once, when the assessment lands
   */
  constructor(o) {
    const cfg = o.config && typeof o.config === 'object' ? o.config : {};
    this.config = cfg;
    this.moduleId = o.moduleId ?? null;
    this.client = o.client;
    this.onChange = o.onChange ?? (() => {});
    this.onAssessed = o.onAssessed ?? (() => {});
    this.persona = typeof cfg.persona === 'string' ? cfg.persona : '';
    this.objective = typeof cfg.objective === 'string' ? cfg.objective : '';
    // A node calls its rubric `rubric`; a hotspot character calls it `criteria` (spec section 7).
    const rubric = Array.isArray(cfg.rubric) ? cfg.rubric : Array.isArray(cfg.criteria) ? cfg.criteria : [];
    this.criteria = rubric.filter((c) => c && typeof c === 'object' && typeof c.id === 'string' && typeof c.label === 'string').map((c) => ({ id: c.id, label: c.label, weight: Number(c.weight) > 0 ? Number(c.weight) : 1 }));
    const states = Array.isArray(cfg.visual?.states) ? cfg.visual.states : [];
    this.moodStates = states.filter((s) => s && typeof s.label === 'string' && s.label.trim()).map((s) => (typeof s.cue === 'string' && s.cue ? { label: s.label, cue: s.cue } : { label: s.label }));
    const max = Number(cfg.maxTurns);
    this.maxTurns = Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_TURNS;
    const first = typeof cfg.firstMessage === 'string' ? cfg.firstMessage.trim() : '';
    this.messages = first ? [{ role: 'character', content: first }] : [];
    this.status = 'open'; // open | replying | degraded | assessing | done
    this.error = null;
    this.draft = '';
    this.assessment = null;
    this.usage = null;
    this.degraded = false;
  }

  get learnerTurns() {
    return this.messages.filter((m) => m.role === 'learner').length;
  }

  get turnsLeft() {
    return this.degraded ? 0 : Math.max(0, this.maxTurns - this.learnerTurns);
  }

  get busy() {
    return this.status === 'replying' || this.status === 'assessing';
  }

  get done() {
    return this.status === 'done';
  }

  get canSend() {
    return this.status === 'open' && this.turnsLeft > 0;
  }

  /** Something must have been said first, as online; a failed finalize can be retried. */
  get canEnd() {
    return this.learnerTurns > 0 && !this.busy && !this.done;
  }

  emit() {
    this.onChange(this);
  }

  params() {
    return { moduleId: this.moduleId, persona: this.persona, objective: this.objective, moodStates: this.moodStates, messages: this.messages, criteria: this.criteria };
  }

  /** One learner line: appended, answered by the receiver, the reply appended with its mood. */
  async send(text) {
    const content = String(text ?? '').trim();
    if (!content || !this.canSend) return null;
    const before = this.messages;
    const withLearner = [...before, { role: 'learner', content }];
    this.messages = withLearner;
    this.draft = '';
    this.error = null;
    this.status = 'replying';
    this.emit();
    let turn;
    try {
      turn = await this.client.conversationTurn({ ...this.params(), messages: withLearner });
    } catch (e) {
      // The line is handed back to the learner to send again, as online.
      this.messages = before;
      this.draft = content;
      this.error = e?.message ?? String(e);
      this.errorCode = e?.code ?? 'error';
      this.status = 'open';
      this.emit();
      return null;
    }
    const reply = { role: 'character', content: turn.reply };
    if (turn.mood) reply.mood = turn.mood;
    this.messages = [...withLearner, reply];
    this.usage = turn.usage ?? this.usage;
    if (turn.degraded) {
      this.degraded = true;
      this.status = 'degraded';
    } else this.status = 'open';
    this.emit();
    // Reaching maxTurns ends the conversation (the platform waits for a tap; this player does not).
    if (!this.degraded && this.turnsLeft === 0) await this.end();
    return turn;
  }

  /** End and assess: `finalize: true` with the full transcript. */
  async end() {
    if (!this.canEnd) return null;
    this.error = null;
    this.status = 'assessing';
    this.emit();
    let out;
    try {
      out = await this.client.conversationFinalize(this.params());
    } catch (e) {
      this.error = e?.message ?? String(e);
      this.errorCode = e?.code ?? 'error';
      this.status = this.degraded ? 'degraded' : 'open';
      this.emit();
      return null;
    }
    this.assessment = out.assessment;
    this.usage = out.usage ?? this.usage;
    this.status = 'done';
    this.onAssessed(this.assessment, this.messages);
    this.emit();
    return this.assessment;
  }
}

/**
 * A run wired to the engine for a `conversation` node: when the assessment
 * lands, the engine records the answer with the score and writes
 * `scoreVariableId` (Engine.answerConversation).
 */
export function attachConversation(engine, client, view, { moduleId = null, onChange } = {}) {
  return new ConversationRun({
    config: view.config,
    moduleId,
    client,
    onChange,
    onAssessed: (assessment, messages) => {
      engine.answerConversation({ messages, assessment });
    },
  });
}

/**
 * The same, for a scene hotspot's `conversation` block (spec section 7):
 * the answer is recorded against the hotspot and the score variable written,
 * then the scene's `abortWhen` is re-checked (Engine.answerHotspotConversation).
 */
export function attachHotspotConversation(engine, client, view, hotspot, { moduleId = null, onChange } = {}) {
  return new ConversationRun({
    config: hotspot.conversation,
    moduleId,
    client,
    onChange,
    onAssessed: (assessment, messages) => {
      engine.answerHotspotConversation(hotspot.id, { messages, assessment });
    },
  });
}
