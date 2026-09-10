// Rendering. Takes an Engine and a media resolver and draws whatever the
// engine's view() says. All DOM lives here and in pano.js / sanitize.js; the
// engine never touches it.

import { sanitizeHtml } from './sanitize.js';
import { PanoView } from './pano.js';
import { buildRecordBody, createRecordSender, certificateUrl, recordModuleId } from './receiver.js';
import { attachConversation, attachHotspotConversation } from './conversation.js';

/** Tiny element helper: h('div.card', {onclick}, child, 'text') */
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'class') el.className = v;
      else if (k in el && k !== 'style' && k !== 'list') {
        try {
          el[k] = v;
        } catch {
          el.setAttribute(k, v);
        }
      } else el.setAttribute(k, v === true ? '' : v);
    }
  } else if (attrs != null) children.unshift(attrs);
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  if (name === 'button' && !el.getAttribute('type')) el.type = 'button';
  return el;
}

const VIDEO_EMBED_HOSTS = /^(www\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|player\.vimeo\.com)$/i;

function embedUrlFor(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!VIDEO_EMBED_HOSTS.test(u.hostname)) return null;
  if (/youtu\.be$/i.test(u.hostname)) return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(u.pathname.slice(1))}`;
  if (/youtube/i.test(u.hostname)) {
    const id = u.searchParams.get('v') ?? (u.pathname.startsWith('/embed/') ? u.pathname.slice(7) : null);
    return id ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` : null;
  }
  if (/vimeo/i.test(u.hostname)) {
    const id = u.pathname.split('/').filter(Boolean).pop();
    return /^\d+$/.test(id ?? '') ? `https://player.vimeo.com/video/${id}` : null;
  }
  return null;
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function fmtClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function fmtWhen(ms) {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return new Date(ms).toISOString();
  }
}

function short(value, max = 60) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s == null) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export class PlayerUI {
  /**
   * @param {object} o  { root, engine, resolver, manifest, onClose, onDownload,
   *   receiver (ReceiverController, optional), receiverControl (fn(ctl, opts) -> element),
   *   priorSent (a stored "sent" flag for this file, optional), onSent(sent) }
   */
  constructor(o) {
    this.root = o.root;
    this.engine = o.engine;
    this.resolver = o.resolver;
    this.manifest = o.manifest;
    this.onClose = o.onClose ?? (() => {});
    this.onDownload = o.onDownload ?? (() => {});
    this.receiver = o.receiver ?? null;
    this.receiverControl = o.receiverControl ?? null;
    this.priorSent = o.priorSent ?? null;
    this.onSent = o.onSent ?? (() => {});
    this.moduleId = recordModuleId(this.manifest);
    this.sender = null; // createRecordSender for the current session, made on first use
    this.sendError = null;
    this.sending = false;
    this.lastRevision = -1;
    this.pano = null;
    this.locals = {}; // per-node UI state (selections before submit), keyed by node id; a nested interaction has its own
  }

  /** The UI-only state for a view: the node's, or the nested interaction's (its id is `<sceneId>/<hotspotId>`). */
  loc(view) {
    return (this.locals[view.node.id] ??= {});
  }

  mount() {
    this.root.replaceChildren();
    this.header = h('header.player-header');
    this.stage = h('main.stage', { id: 'stage' });
    this.footer = h('footer.player-footer');
    this.root.append(this.header, this.stage, this.footer);
    this.engine.start();
    this.render(true);
    this.timer = setInterval(() => {
      const changed = this.engine.tick();
      if (changed || this.engine.revision !== this.lastRevision) this.render();
      else this.updateTimers();
    }, 250);
  }

  destroy() {
    clearInterval(this.timer);
    this.clearLocals();
    this.pano?.destroy();
    this.pano = null;
    this.root.replaceChildren();
  }

  /** Drop per-node UI state, running any cleanup a node registered (a fullscreen listener, for one). */
  clearLocals() {
    for (const local of Object.values(this.locals)) {
      try {
        local?.cleanup?.();
      } catch (e) {
        console.warn(e);
      }
    }
    this.locals = {};
  }

  refresh() {
    this.render();
  }

  render(force = false) {
    const view = this.engine.view();
    if (!force && view.revision === this.lastRevision) return;
    const nodeChanged = view.kind !== 'node' || this.currentNodeId !== view.node.id;
    this.lastRevision = view.revision;
    this.currentNodeId = view.kind === 'node' ? view.node.id : null;
    if (nodeChanged) {
      this.clearLocals();
      this.pano?.destroy();
      this.pano = null;
    }
    this.renderHeader(view);
    this.renderStage(view, nodeChanged);
    this.renderFooter(view);
    if (nodeChanged) this.stage.scrollTop = 0;
  }

  renderHeader(view) {
    const title = this.manifest?.module?.title ?? 'Untitled';
    const timers = [];
    for (const [scope, t] of Object.entries(view.timers)) {
      if (!t || !t.visible) continue;
      timers.push(h(`span.timer.timer-${scope}${t.warning ? '.is-warning' : ''}${t.expired ? '.is-expired' : ''}`, { dataset: { scope } }, t.label ? h('span.timer-label', t.label) : null, h('span.timer-value', fmtTime(t.display))));
    }
    this.header.replaceChildren(
      h('div.header-title', { title }, title),
      h('div.header-timers', timers),
      h('div.header-actions',
        h('button.btn.btn-ghost.btn-small', { onclick: () => this.openRecordPanel(), title: 'What has happened in this session so far' }, 'Session record'),
        this.receiver && this.receiverControl ? this.receiverControl(this.receiver, { compact: true, onChange: () => this.render(true) }) : null,
        h('button.btn.btn-ghost.btn-small', { onclick: () => this.onClose(), title: 'Close this file' }, 'Close'),
      ),
    );
  }

  /** The Session record panel: every engine event so far, and Download JSON. */
  openRecordPanel() {
    const dialog = h('dialog.record-panel', { 'aria-labelledby': 'record-title' });
    const list = h('ol.record-list');
    const events = this.engine.events;
    if (!events.length) list.append(h('li.muted', 'Nothing yet.'));
    for (const e of events) {
      list.append(h('li', h('time.record-time', { datetime: new Date(e.at).toISOString() }, fmtClock(e.at)), h('span.record-what', describeEvent(e, this.engine))));
    }
    dialog.append(
      h('h2', { id: 'record-title' }, 'Session record'),
      h('p.small.muted', `${events.length} event${events.length === 1 ? '' : 's'} so far. The download is the full record: xAPI-shaped statements plus the raw events, variables, answers and scores.`),
      list,
      h('div.actions.actions-wrap',
        h('button.btn.btn-primary', { onclick: () => this.onDownload() }, 'Download JSON'),
        h('button.btn', { onclick: () => dialog.close() }, 'Close'),
      ),
    );
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  updateTimers() {
    const view = this.engine.view();
    for (const [scope, t] of Object.entries(view.timers)) {
      const el = this.header.querySelector(`.timer-${scope}`);
      if (!el) {
        if (t && t.visible) this.renderHeader(view);
        continue;
      }
      el.querySelector('.timer-value').textContent = fmtTime(t.display);
      el.classList.toggle('is-warning', Boolean(t.warning));
      el.classList.toggle('is-expired', Boolean(t.expired));
    }
  }

  renderFooter(view) {
    this.footer.replaceChildren();
    if (view.kind !== 'node') return;
    const type = view.type;
    if (type === 'choice') return;
    const cfg = view.config;
    // showContinueButton:false only hides the button when the node has another way out (G16).
    const hasOtherExit = Boolean(cfg.timer && cfg.timer.mode === 'countdown' && ['advance', 'route', 'end'].includes(cfg.timer.onExpire?.behavior)) || cfg.advanceOnAnswer === true;
    if (cfg.showContinueButton === false && hasOtherExit) return;
    if (['textInput', 'multipleChoice', 'ranking', 'matching', 'rating', 'procedure', 'dragToTarget'].includes(type) && !view.state.answered) return;
    // A live conversation has its own End button; Continue appears once it is assessed or given up on.
    if (type === 'conversation' && view.supported && !view.state.answered && !view.state.fallback) return;
    const label = view.connection ? 'Continue' : 'Finish';
    this.footer.append(h('button.btn.btn-primary.btn-wide', { disabled: !view.canContinue, onclick: () => this.act(() => this.engine.continue()) }, label));
  }

  act(fn) {
    try {
      fn();
    } catch (e) {
      console.error(e);
      this.toast(e.message ?? String(e));
    }
    this.render();
  }

  toast(msg) {
    const t = h('div.toast', msg);
    this.root.append(t);
    setTimeout(() => t.remove(), 3000);
  }

  renderStage(view, nodeChanged) {
    if (view.kind === 'end') {
      this.stage.replaceChildren(this.renderEnd(view));
      return;
    }
    if (view.kind !== 'node') return;
    // A scene keeps one card element across renders so the Fullscreen API has a stable target.
    let card;
    if (view.type === 'scene' && view.supported) {
      const local = this.loc(view);
      card = local.card ??= h('article.card.card-scene', { dataset: { type: 'scene' } });
      card.replaceChildren();
    } else card = h('article.card', { dataset: { type: view.type } });
    const badge = view.provisional ? h('span.badge.badge-provisional', 'provisional') : null;
    if (!view.supported) card.append(this.renderFallback(view));
    else {
      const fn = this[`render_${view.type}`];
      if (typeof fn === 'function') fn.call(this, view, card, nodeChanged, badge);
      else card.append(this.renderFallback(view));
    }
    if (this.stage.childNodes.length !== 1 || this.stage.firstChild !== card) this.stage.replaceChildren(card);
  }

  heading(view, badge) {
    // A nested interaction (spec section 7.2) sits inside the scene card, so its heading is one level down.
    return h(view.nested ? 'h3.card-title.card-title-nested' : 'h2.card-title', view.title, badge ? ' ' : null, badge);
  }

  // ---- node renderers -----------------------------------------------------

  renderFallback(view) {
    const conversation = view.type === 'conversation';
    return h('div.fallback',
      h('h2.card-title', view.title || view.node.id),
      conversation ? h('p.muted', 'This step is a conversation with an AI character, which needs a connected receiver to run.') : h('p.muted', `This step needs a newer player (node type "${view.rawType}").`),
      conversation && view.config.firstMessage ? h('blockquote', String(view.config.firstMessage)) : null,
      conversation && this.receiver && !this.receiver.connected ? this.connectPrompt('Connect to RonuNest to talk to the character') : null,
      view.type === 'code' ? h('p.muted', 'Code steps run in a sandbox this player does not ship. The code was not executed.') : null,
    );
  }

  /** A button that runs the connect flow and redraws whatever screen is showing. */
  connectPrompt(label) {
    return h('div.actions', h('button.btn.btn-primary', { onclick: async () => { await this.receiver.connect(); this.render(true); } }, label));
  }

  // ---- conversation through the receiver (record-receiver section 4) ----

  /** The live chat card. `run` is a ConversationRun; `onGiveUp` shows the fallback instead; `after` is drawn below the assessment. */
  renderConversationCard(run, { title, badge, intro, onGiveUp, after = null, nested = false } = {}) {
    const wrap = h(nested ? 'div.conversation.is-nested' : 'div.conversation');
    if (title) wrap.append(h(nested ? 'h3.card-title.card-title-nested' : 'h2.card-title', title, badge ? ' ' : null, badge));
    if (intro) wrap.append(h('p.hint', intro));
    const name = run.config.visual?.characterName || 'Character';
    const log = h('div.chat', { role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
    if (!run.messages.length) log.append(h('p.muted.small', 'Say hello to start the conversation.'));
    for (const m of run.messages) {
      const bubble = h(`div.bubble${m.role === 'learner' ? '.is-learner' : '.is-character'}`, h('span.bubble-who', m.role === 'learner' ? 'You' : name), h('p.bubble-text', m.content));
      if (m.role === 'character' && m.mood) bubble.append(h('span.mood', { title: 'How the character feels' }, m.mood));
      log.append(bubble);
    }
    if (run.status === 'replying') log.append(h('div.bubble.is-character.is-pending', h('span.bubble-who', name), h('p.bubble-text.muted', 'replying…')));
    if (run.status === 'assessing') log.append(h('p.muted.small', 'Assessing the conversation…'));
    if (run.assessment) {
      const a = run.assessment;
      const box = h('div.assessment', h('p.score', `Conversation complete. Score: ${a.score}/100`), a.summary ? h('p', a.summary) : null);
      if (Array.isArray(a.criteria) && a.criteria.length) {
        box.append(h('ul.criteria', a.criteria.map((c) => {
          const label = run.criteria.find((r) => r.id === c.id)?.label ?? c.id;
          return h('li', h('strong', label), typeof c.score === 'number' ? ` ${c.score}/100` : '', c.comment ? `: ${c.comment}` : '');
        })));
      }
      log.append(box);
    }
    wrap.append(log);
    if (run.error) wrap.append(h('p.error', run.error));
    if (run.status === 'degraded') wrap.append(h('p.note', `${name} can only wrap up now (the creator's conversation allowance on ${this.receiver?.name ?? 'the receiver'} is spent). End the conversation to get your assessment.`));

    if (!run.done) {
      const local = { focus: false };
      const ta = h('textarea.input', { rows: 2, placeholder: run.canSend ? 'Type your reply. Enter sends, Shift+Enter for a new line.' : run.status === 'degraded' ? 'No more replies. End the conversation.' : 'Waiting…', value: run.draft ?? '', disabled: !run.canSend, 'aria-label': 'Your reply' });
      const send = () => {
        const text = ta.value;
        if (!text.trim() || !run.canSend) return;
        local.focus = true;
        run.send(text);
      };
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      });
      ta.addEventListener('input', () => {
        run.draft = ta.value;
      });
      const sendBtn = h('button.btn.btn-primary', { disabled: !run.canSend, onclick: send }, 'Send');
      // One mis-tap must not end the chat: the first tap arms, the second ends (as online).
      const endBtn = h('button.btn', { disabled: !run.canEnd, title: run.canEnd ? undefined : 'Say something first; you can end the conversation once you have spoken.' }, run.status === 'degraded' ? 'End and assess' : 'End conversation');
      let armed = false;
      let armTimer = null;
      endBtn.addEventListener('click', () => {
        if (!run.canEnd) return;
        if (armed || run.status === 'degraded') {
          clearTimeout(armTimer);
          run.end();
          return;
        }
        armed = true;
        endBtn.textContent = 'Tap again to end and get feedback';
        endBtn.classList.add('is-armed');
        armTimer = setTimeout(() => {
          armed = false;
          endBtn.textContent = 'End conversation';
          endBtn.classList.remove('is-armed');
        }, 4000);
      });
      wrap.append(
        h('div.chat-input', ta, sendBtn),
        h('div.chat-meta', h('span.small.muted', `${run.turnsLeft} repl${run.turnsLeft === 1 ? 'y' : 'ies'} left`), endBtn),
      );
      if (run.error && onGiveUp) wrap.append(h('div.actions', h('button.btn.btn-ghost', { onclick: onGiveUp }, 'Skip the character and continue')));
      if (run.draft && !run.busy) queueMicrotask(() => ta.focus());
    }
    if (after) wrap.append(after);
    return wrap;
  }

  render_conversation(view, card, _n, badge) {
    if (!this.receiver?.connected || !this.receiver.client) {
      card.append(this.renderFallback(view));
      return;
    }
    const st = view.state;
    if (st.fallback) {
      card.append(this.renderFallback(view), h('p.muted.small', 'The character could not be reached; this step was skipped.'));
      return;
    }
    const local = this.loc(view);
    if (!local.run || local.run.client !== this.receiver.client) {
      local.run = attachConversation(this.engine, this.receiver.client, view, { moduleId: this.moduleId, onChange: () => this.render(true) });
    }
    card.append(this.renderConversationCard(local.run, {
      title: view.title,
      badge: badge ?? h('span.badge.badge-provisional', 'provisional'),
      intro: view.instructions || view.question || null,
      onGiveUp: () => this.act(() => this.engine.conversationFallback()),
    }));
  }

  render_message(view, card, _n, badge) {
    card.append(this.heading(view, badge));
    const body = h('div.prose');
    body.append(sanitizeHtml(view.content, (ref) => this.resolver.resolve(ref)));
    card.append(body);
    const files = Array.isArray(view.config.files) ? view.config.files : [];
    if (files.length) {
      const list = h('ul.attachments');
      for (const f of files) {
        if (!f || typeof f !== 'object') continue;
        const url = this.resolver.resolve(f.path ?? f.data ?? f.url ?? '');
        const name = f.name ?? f.path ?? 'attachment';
        list.append(h('li', url ? h('a', { href: url, download: name, target: '_blank', rel: 'noopener' }, name) : h('span.muted', `${name} (not bundled)`)));
      }
      card.append(h('h3.section-title', 'Attachments'), list);
    }
  }

  render_video(view, card, nodeChanged, badge) {
    card.append(this.heading(view, badge));
    const cfg = view.config;
    const src = this.resolver.resolve(cfg.videoUrl);
    const embed = src ? embedUrlFor(src) : null;
    if (embed) {
      card.append(h('div.video-frame', h('iframe', { src: embed, allow: 'autoplay; encrypted-media; picture-in-picture', allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin', title: view.title || 'Video' })));
    } else if (src) {
      const c = cfg.videoControls ?? {};
      const video = h('video', { src, controls: true, playsinline: true, preload: 'metadata', autoplay: c.autoplay === true, poster: this.resolver.resolve(cfg.thumbnailUrl) ?? undefined });
      const subs = this.resolver.resolve(cfg.subtitlesUrl);
      if (subs) video.append(h('track', { kind: 'subtitles', src: subs, default: c.showSubtitles !== false }));
      const triggers = Array.isArray(cfg.triggers) ? cfg.triggers : [];
      const done = triggers.filter((t) => t?.type === 'onVideoComplete');
      const stamps = triggers.filter((t) => t?.type === 'onVideoTimestamp').map((t) => ({ t, at: Number(t.config?.timestamp ?? 0), fired: false }));
      video.addEventListener('ended', () => {
        this.loc(view).videoEnded = true;
        for (const t of done) this.engine.applyActions(t.actions, 'trigger:onVideoComplete');
        this.engine.bump();
        this.render();
      });
      video.addEventListener('timeupdate', () => {
        for (const s of stamps) {
          if (!s.fired && video.currentTime >= s.at) {
            s.fired = true;
            this.engine.applyActions(s.t.actions, 'trigger:onVideoTimestamp');
            this.engine.bump();
            this.render();
          }
        }
      });
      card.append(h('div.video-frame', video));
    } else {
      card.append(h('p.muted', cfg.videoUrl ? 'This video is not bundled in the file and cannot be played offline.' : 'No video set.'));
    }
    if (cfg.question) card.append(h('p.question', view.question));
  }

  render_choice(view, card, _n, badge) {
    card.append(this.heading(view, badge));
    if (view.question) card.append(h('p.question', view.question));
    const choices = Array.isArray(view.config.choices) ? view.config.choices : [];
    const list = h('div.choices');
    choices.forEach((c, i) => {
      if (!c || typeof c !== 'object') return;
      const id = c.id ?? c.text ?? String(i);
      list.append(h('button.btn.btn-choice', { onclick: () => this.act(() => this.engine.choose(id)) }, this.engine.substitute(c.text ?? '')));
    });
    if (!choices.length) list.append(h('p.muted', 'This decision has no options.'));
    card.append(list);
  }

  render_textInput(view, card, _n, badge) {
    card.append(this.heading(view, badge));
    if (view.question) card.append(h('p.question', view.question));
    const st = view.state;
    if (st.answered) {
      card.append(h('blockquote.answer', String(this.engine.responses[view.node.id]?.response ?? '')));
      return;
    }
    const local = this.loc(view);
    const ta = h('textarea.input', { rows: 4, placeholder: 'Type your answer', value: local.text ?? '', oninput: (e) => (local.text = e.target.value) });
    const submit = h('button.btn.btn-primary', { onclick: () => this.act(() => { this.engine.answerText(ta.value); if (!view.nested && !this.engine.ended && this.engine.canContinue()) this.engine.continue(); }) }, 'Submit');
    card.append(ta, h('div.actions', submit));
  }

  render_multipleChoice(view, card, _n, badge) {
    card.append(this.heading(view, badge));
    if (view.question) card.append(h('p.question', view.question));
    const cfg = view.config;
    const multi = cfg.allowMultiple === true;
    const choices = Array.isArray(cfg.choices) ? cfg.choices : [];
    const st = view.state;
    const local = this.loc(view);
    const picked = new Set(local.picked ?? []);
    if (st.answered) {
      const ids = this.engine.responses[view.node.id]?.response ?? [];
      card.append(h('ul.picked', choices.filter((c) => ids.includes(c.id)).map((c) => h('li', this.engine.substitute(c.text ?? '')))));
      return;
    }
    const list = h('div.options');
    choices.forEach((c, i) => {
      if (!c || typeof c !== 'object') return;
      const id = c.id ?? String(i);
      const input = h('input', { type: multi ? 'checkbox' : 'radio', name: `mc-${view.node.id}`, value: id, checked: picked.has(id) });
      input.addEventListener('change', () => {
        if (multi) {
          if (input.checked) picked.add(id);
          else picked.delete(id);
        } else {
          picked.clear();
          picked.add(id);
        }
        local.picked = [...picked];
        if (!multi && cfg.advanceOnAnswer) setTimeout(() => this.act(() => { this.engine.answerMultiple([...picked]); if (!view.nested && !this.engine.ended) this.engine.continue(); }), 300);
      });
      list.append(h('label.option', input, h('span', this.engine.substitute(c.text ?? ''))));
    });
    card.append(list, h('div.actions', h('button.btn.btn-primary', { onclick: () => this.act(() => { this.engine.answerMultiple([...picked]); if (!view.nested && !this.engine.ended && this.engine.canContinue()) this.engine.continue(); }) }, 'Submit')));
  }

  render_ranking(view, card, _n, badge) {
    card.append(this.heading(view, badge));
    if (view.question) card.append(h('p.question', view.question));
    const items = (Array.isArray(view.config.rankingItems) ? view.config.rankingItems : []).map((it) => (typeof it === 'string' ? it : it?.text ?? it?.label ?? String(it?.id ?? '')));
    if (view.state.answered) {
      card.append(h('ol.ranked', (this.engine.responses[view.node.id]?.response ?? []).map((t) => h('li', t))));
      return;
    }
    const local = this.loc(view);
    const order = local.order ?? items.slice();
    local.order = order;
    const list = h('ol.rank-list');
    order.forEach((text, i) => {
      const move = (d) => {
        const j = i + d;
        if (j < 0 || j >= order.length) return;
        [order[i], order[j]] = [order[j], order[i]];
        this.render(true);
      };
      list.append(h('li.rank-item',
        h('span.rank-pos', String(i + 1)),
        h('span.rank-text', this.engine.substitute(text)),
        h('span.rank-controls',
          h('button.btn.btn-icon', { onclick: () => move(-1), disabled: i === 0, 'aria-label': `Move ${text} up` }, '↑'),
          h('button.btn.btn-icon', { onclick: () => move(1), disabled: i === order.length - 1, 'aria-label': `Move ${text} down` }, '↓'),
        ),
      ));
    });
    card.append(h('p.hint', 'Use the arrows to put these in order, best first.'), list,
      h('div.actions', h('button.btn.btn-primary', { onclick: () => this.act(() => { this.engine.answerRanking(order); if (!view.nested && !this.engine.ended && this.engine.canContinue()) this.engine.continue(); }) }, 'Submit')));
  }

  render_matching(view, card, _n, badge) {
    card.append(this.heading(view, badge));
    if (view.question) card.append(h('p.question', view.question));
    const cfg = view.config;
    const left = Array.isArray(cfg.matchingLeftItems) ? cfg.matchingLeftItems : [];
    const right = Array.isArray(cfg.matchingRightItems) ? cfg.matchingRightItems : [];
    const st = view.state;
    const local = this.loc(view);
    const matches = local.matches ?? {};
    local.matches = matches;
    const table = h('div.match-table');
    for (const l of left) {
      if (!l || !l.id) continue;
      const chosen = st.answered ? this.engine.responses[view.node.id]?.response?.[l.id] : matches[l.id];
      const row = h('div.match-row');
      row.append(h('span.match-left', this.engine.substitute(l.text ?? '')));
      if (st.answered) {
        const r = right.find((x) => x?.id === chosen);
        const ok = st.feedback?.perItem?.[l.id];
        row.append(h(`span.match-result${ok === true ? '.is-correct' : ok === false ? '.is-wrong' : ''}`, r?.text ?? '(no match)', ok === true ? ' ✓' : ok === false ? ' ✗' : ''));
      } else {
        const sel = h('select.input', { onchange: (e) => { if (e.target.value) matches[l.id] = e.target.value; else delete matches[l.id]; } },
          h('option', { value: '' }, 'Choose'),
          right.map((r) => h('option', { value: r?.id ?? '', selected: chosen === r?.id }, this.engine.substitute(r?.text ?? ''))));
        row.append(sel);
      }
      table.append(row);
    }
    card.append(table);
    if (st.answered) {
      if (st.feedback) card.append(h('p.score', `${st.feedback.correct} of ${st.feedback.total} correct`));
      return;
    }
    card.append(h('div.actions', h('button.btn.btn-primary', { onclick: () => this.act(() => { this.engine.answerMatching(matches); if (!view.nested && cfg.matchingGraded === false && !this.engine.ended) this.engine.continue(); }) }, 'Submit')));
  }

  render_rating(view, card, _n, badge) {
    card.append(this.heading(view, badge));
    if (view.question) card.append(h('p.question', view.question));
    const cfg = view.config;
    const min = Number(cfg.ratingMin ?? 1);
    const max = Number(cfg.ratingMax ?? 5);
    const style = cfg.ratingStyle ?? 'numbers';
    const current = view.state.answered ? this.engine.responses[view.node.id]?.response : null;
    const row = h('div.rating-row', { role: 'radiogroup', 'aria-label': view.question || 'Rating' });
    for (let v = min; v <= max && v - min < 50; v++) {
      const label = style === 'stars' ? '★' : style === 'emoji' ? (cfg.ratingEmoji || '⭐') : String(v);
      row.append(h(`button.btn.rating-btn${current != null && v <= current ? '.is-active' : ''}`, { role: 'radio', 'aria-checked': current === v, 'aria-label': String(v), onclick: () => this.act(() => this.engine.answerRating(v)) }, label));
    }
    card.append(row, h('div.rating-labels', h('span', cfg.ratingLowLabel ?? ''), h('span', cfg.ratingHighLabel ?? '')));
  }

  render_scene(view, card, nodeChanged, badge) {
    const cfg = view.config;
    const st = view.state;
    const kind = this.engine.sceneKind(view.node);
    const hotspots = this.engine.sceneHotspots(view.node);
    card.classList.add('card-scene');
    card.append(this.heading(view, badge));
    if (view.instructions) card.append(h('p.hint', view.instructions));

    const local = this.loc(view);
    const markers = hotspots.map((hs) => {
      const visited = st.visited.includes(hs.id);
      // A hotspot with an interaction only reads as done once it is answered (spec section 7.2).
      return { id: hs.id, label: hs.label ?? '', visible: !hs.hidden || visited, found: this.engine.hotspotSatisfied(view.node, hs), locked: this.engine.hotspotLocked(view.node, hs), yaw: hs.position?.yaw ?? 0, pitch: hs.position?.pitch ?? 0, x: hs.position?.x ?? 0, y: hs.position?.y ?? 0 };
    });
    const src = this.resolver.resolve(cfg.environment?.source);
    const viewport = local.viewport ?? h('div.scene-viewport');
    local.viewport = viewport;
    card.append(viewport);
    card.classList.toggle('has-beat', Boolean(st.beat));

    // Fullscreen: the whole scene card (viewport plus the in-room cards) fills the screen.
    if (typeof card.requestFullscreen === 'function' || typeof document.exitFullscreen === 'function') {
      const isFull = document.fullscreenElement === card;
      const fsBtn = h('button.btn.btn-small.btn-fullscreen', { 'aria-pressed': isFull, title: isFull ? 'Exit fullscreen' : 'Fullscreen', onclick: () => {
        if (document.fullscreenElement === card) document.exitFullscreen?.().catch?.(() => {});
        else card.requestFullscreen?.()?.catch?.((e) => this.toast(`Fullscreen is not available: ${e.message}`));
      } }, isFull ? 'Exit fullscreen' : 'Fullscreen');
      if (!local.fsListener) {
        local.fsListener = () => this.render(true);
        document.addEventListener('fullscreenchange', local.fsListener);
        local.cleanup = () => document.removeEventListener('fullscreenchange', local.fsListener);
      }
      card.append(fsBtn);
    }

    if (kind === 'photo360') {
      if (!this.pano) {
        this.pano = new PanoView(viewport, { src, onTap: (p) => this.act(() => this.engine.tapScene(p)), onMarker: (id) => this.act(() => this.engine.activateHotspot(id)) });
        if (!src) viewport.append(h('p.scene-note', 'No panorama image is bundled; the scene is shown as a blank backdrop.'));
      }
      this.pano.setMarkers(markers);
    } else {
      if (!local.flat) {
        const flat = h('div.scene-flat');
        const img = src ? h('img', { src, alt: view.title || 'Scene', draggable: false }) : h('div.scene-blank');
        flat.append(img);
        flat.addEventListener('click', (e) => {
          if (e.target.closest('.hotspot-marker')) return;
          const r = flat.getBoundingClientRect();
          this.act(() => this.engine.tapScene({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }));
        });
        viewport.append(flat);
        local.flat = flat;
      }
      const flat = local.flat;
      for (const old of flat.querySelectorAll('.hotspot-marker')) old.remove();
      for (const m of markers) {
        if (!m.visible) continue;
        const b = h(`button.hotspot-marker${m.found ? '.is-found' : ''}${m.locked ? '.is-locked' : ''}`, { style: `left:${m.x * 100}%;top:${m.y * 100}%`, 'aria-label': m.label || 'Hotspot', onclick: (e) => { e.stopPropagation(); this.act(() => this.engine.activateHotspot(m.id)); } }, h('span.hotspot-dot'), h('span.hotspot-label', m.label));
        flat.append(b);
      }
    }

    // Status line. A required hotspot with a question counts once it is answered.
    const required = hotspots.filter((hs) => hs.required);
    const doneReq = required.filter((hs) => this.engine.hotspotSatisfied(view.node, hs)).length;
    const parts = [];
    if (cfg.completion === 'allRequired' && required.length) parts.push(`${doneReq} of ${required.length} required done`);
    else if (hotspots.length) parts.push(`${st.visited.length} of ${hotspots.length} found`);
    if (st.lastTap?.kind === 'miss') parts.push('Nothing there.');
    if (st.lastTap?.kind === 'locked') parts.push('Not yet. Look at the earlier ones first.');
    if (kind === 'photo360') parts.push('Drag to look around.');
    card.append(h('p.scene-status', parts.join(' · ')));

    // Beat overlay: conversation fallback, the in-room interaction, or the reveal.
    if (st.beat) {
      const hs = hotspots.find((x) => x.id === st.beat.hotspotId);
      const panel = h('div.reveal', { dataset: { beat: st.beat.kind } });
      const dismiss = () => this.act(() => this.engine.dismissBeat());
      const goLabel = hs?.targetNodeId && st.beat.then.length === 1 ? 'Go' : 'OK';
      if (st.beat.kind === 'reveal') {
        const r = hs?.reveal ?? {};
        panel.append(h('h3', r.title ?? hs?.label ?? ''));
        const kindR = r.kind ?? 'text';
        const media = this.resolver.resolve(r.src ?? r.url ?? r.source ?? '');
        if (kindR === 'image' && media) panel.append(h('img.reveal-media', { src: media, alt: r.alt ?? '' }));
        else if (kindR === 'video' && media) panel.append(h('video.reveal-media', { src: media, controls: true, playsinline: true }));
        if (r.body) panel.append(h('p', this.engine.substitute(String(r.body))));
        if (!r.body && kindR !== 'text' && !media) panel.append(h('p.muted', 'This reveal is not bundled.'));
        panel.append(h('div.actions', h('button.btn.btn-primary', { onclick: dismiss }, goLabel)));
      } else if (st.beat.kind === 'interaction' && view.interaction) {
        // Spec section 7.2: the hotspot's question, drawn by the same renderer
        // as the top-level node type, answered here, never routing. The engine
        // sends answer calls to the nested sub-node while this beat is open.
        const iv = view.interaction;
        panel.classList.add('is-interaction');
        const fn = this[`render_${iv.type}`];
        if (typeof fn === 'function') fn.call(this, iv, panel, false, null);
        else panel.append(h('h3', iv.title), h('p.muted', `This question needs a newer player (type "${iv.rawType}").`));
        const answered = iv.state.answered || iv.type === 'message';
        panel.append(h('div.actions',
          answered
            ? h('button.btn.btn-primary', { onclick: dismiss }, goLabel)
            : h('button.btn.btn-ghost', { onclick: dismiss, title: hs?.required ? 'Close for now; this one is required, so come back and answer it' : 'Close for now' }, 'Close'),
        ));
      } else {
        const c = hs?.conversation ?? {};
        const cst = hs ? this.engine.hotspotConversationState(hs.id) : null;
        const live = Boolean(cst && this.receiver?.connected && this.receiver.client && !cst.fallback);
        if (live) {
          // A character in the room, through the receiver (record-receiver section 4).
          panel.classList.add('is-interaction');
          const runs = (local.runs ??= {});
          if (!runs[hs.id] || runs[hs.id].client !== this.receiver.client) {
            runs[hs.id] = attachHotspotConversation(this.engine, this.receiver.client, view, hs, { moduleId: this.moduleId, onChange: () => this.render(true) });
          }
          const run = runs[hs.id];
          panel.append(this.renderConversationCard(run, {
            title: hs.label ?? 'Conversation',
            nested: true,
            onGiveUp: () => this.act(() => this.engine.hotspotConversationFallback(hs.id)),
            after: h('div.actions', cst.answered
              ? h('button.btn.btn-primary', { onclick: dismiss }, goLabel)
              : h('button.btn.btn-ghost', { onclick: dismiss, title: 'Close for now; the conversation continues when you come back' }, 'Close')),
          }));
        } else {
          panel.append(h('h3', hs?.label ?? 'Conversation'),
            h('p.muted', cst?.fallback ? 'The character could not be reached, so this conversation was skipped. Here is what they would have opened with:' : 'Talking to characters needs a connected receiver. Here is what they would open with:'),
            c.firstMessage ? h('blockquote', String(c.firstMessage)) : null);
          if (this.receiver && !this.receiver.connected) panel.append(this.connectPrompt('Connect to RonuNest to talk to the character'));
          panel.append(h('div.actions', h('button.btn.btn-primary', { onclick: dismiss }, goLabel)));
        }
      }
      card.append(panel);
    }
  }

  render_procedure(view, card, _n, badge) {
    card.append(this.heading(view, badge ?? h('span.badge.badge-provisional', 'provisional')));
    if (view.question) card.append(h('p.question', view.question));
    const st = view.state;
    const steps = this.engine.procedureSteps(view.node);
    card.append(h('p.hint', 'Tap the steps in the order you would do them.'));
    const list = h('div.steps');
    for (const idx of st.order) {
      const s = steps[idx];
      if (!s) continue;
      const done = st.performed.includes(idx);
      const miss = st.missteps.includes(idx);
      const pos = done ? st.performed.indexOf(idx) + 1 : null;
      list.append(h(`button.btn.btn-step${done ? '.is-done' : ''}${miss ? '.is-miss' : ''}`, { disabled: done || st.answered, onclick: () => this.act(() => this.engine.performStep(idx)) },
        pos ? h('span.step-pos', String(pos)) : null, h('span', this.engine.substitute(s.text ?? '')), s.critical ? h('span.badge', 'critical') : null));
    }
    card.append(list);
    if (st.note) card.append(h('p.note', st.note));
    if (st.halted) card.append(h('p.note', 'Stopped: a critical step was done out of turn.'));
    if (st.answered) card.append(h('p.score', `${st.missteps.length === 0 ? 'All steps in order.' : `${st.missteps.length} out of turn.`} Score ${this.engine.nodeScores[view.node.id] ?? 0}%`));
  }

  render_dragToTarget(view, card, _n, badge) {
    card.append(this.heading(view, badge ?? h('span.badge.badge-provisional', 'provisional')));
    if (view.question) card.append(h('p.question', view.question));
    const cfg = view.config;
    const st = view.state;
    const local = this.loc(view);
    const items = (Array.isArray(cfg.dragItems) ? cfg.dragItems : []).filter((i) => i && i.id);
    const targets = (Array.isArray(cfg.dragTargets) ? cfg.dragTargets : []).filter((t) => t && t.id);
    const held = local.held ?? null;
    const media = (m) => {
      const url = this.resolver.resolve(m.image ?? '');
      return url ? h('img.thumb', { src: url, alt: m.label ?? '' }) : null;
    };
    card.append(h('p.hint', held ? 'Now tap where it belongs, or tap "Leave unused".' : 'Tap an item, then tap its place.'));
    const pool = h('div.drag-pool');
    for (const it of items) {
      const placedOn = st.placements[it.id];
      const ok = st.feedback?.perItem?.[it.id];
      pool.append(h(`button.btn.btn-item${held === it.id ? '.is-held' : ''}${placedOn ? '.is-placed' : ''}${ok === true ? '.is-correct' : ok === false ? '.is-wrong' : ''}`, { disabled: st.answered, onclick: () => { local.held = held === it.id ? null : it.id; this.render(true); } },
        media(it), h('span', it.label ?? it.id), placedOn ? h('span.muted', ` → ${targets.find((t) => t.id === placedOn)?.label ?? placedOn}`) : null));
    }
    card.append(pool);
    const zone = h('div.drag-targets');
    for (const t of targets) {
      const inside = items.filter((i) => st.placements[i.id] === t.id);
      zone.append(h('button.btn.btn-target', { disabled: st.answered || !held, onclick: () => this.act(() => { this.engine.placeItem(held, t.id); local.held = null; }) },
        media(t), h('span.target-label', t.label ?? t.id), inside.length ? h('span.muted', ` (${inside.map((i) => i.label ?? i.id).join(', ')})`) : null));
    }
    if (held && st.placements[held]) zone.append(h('button.btn.btn-target.btn-ghost', { onclick: () => this.act(() => { this.engine.placeItem(held, null); local.held = null; }) }, 'Leave unused'));
    card.append(zone);
    if (st.answered) card.append(h('p.score', `${st.feedback.correct} of ${st.feedback.total} right. Score ${this.engine.nodeScores[view.node.id] ?? 0}%`));
    else card.append(h('div.actions', h('button.btn.btn-primary', { onclick: () => this.act(() => this.engine.submitPlacements()) }, 'Check')));
  }

  renderEnd(view) {
    const r = view.result ?? {};
    const status = r.passed === true ? 'Passed' : r.passed === false ? 'Not passed' : 'Completed';
    const card = h('article.card.card-end', h('h2.card-title', status));
    if (view.error) card.append(h('p.note', view.error));
    if (typeof r.score === 'number') {
      const isVar = (r.rule?.mode ?? 'variable') === 'variable' && r.rule;
      const name = isVar ? this.engine.findVariable(r.rule.variableId)?.name : null;
      card.append(h('p.score-big', name ? `${name}: ${r.score}` : `${r.score}%`));
    }
    if (r.rule) card.append(h('p.muted', describeRule(r.rule, this.engine)));
    const vars = view.variables;
    if (vars.length) {
      card.append(h('h3.section-title', 'Variables'));
      card.append(h('table.vars', h('tbody', vars.map((v) => h(`tr${v.visible ? '' : '.is-hidden-var'}`, h('td', v.name), h('td.num', String(v.value)), h('td.muted', v.computed ? 'computed' : ''))))));
    }
    const scores = Object.entries(view.nodeScores);
    if (scores.length) {
      card.append(h('h3.section-title', 'Node scores'));
      card.append(h('table.vars', h('tbody', scores.map(([id, s]) => h('tr', h('td', this.scoreLabel(id)), h('td.num', `${s}%`))))));
    }
    card.append(h('p.muted.small', `Path: ${view.trail.join(' → ')}`));
    const sendBlock = this.renderSendBlock();
    if (sendBlock) card.append(sendBlock);
    card.append(h('div.actions.actions-wrap',
      this.renderSendButton(),
      h('button.btn', { onclick: () => this.playAgain() }, 'Play again'),
      h('button.btn.btn-ghost', { onclick: () => this.onClose() }, 'Open another file'),
      h('button.btn.btn-ghost', { onclick: () => this.onDownload() }, 'Download session record'),
    ));
    return card;
  }

  playAgain() {
    this.engine.start();
    this.clearLocals();
    this.pano?.destroy();
    this.pano = null;
    this.sender = null;
    this.sendError = null;
    this.render(true);
  }

  /** What the end screen says about the receiver: sent, sent before, cannot be sent, or an error. */
  renderSendBlock() {
    const ctl = this.receiver;
    if (!ctl) return null;
    const sent = this.sender?.sent ?? null;
    const box = h('div.send-block');
    if (sent) {
      const verdict = sent.passed === true ? 'passed' : sent.passed === false ? 'not passed' : 'recorded';
      box.append(h('p.score', `Sent to ${sent.receiverName ?? ctl.name}: ${verdict}${typeof sent.score === 'number' ? `, score ${sent.score}` : ''}.`));
      if (sent.certificate) box.append(h('p', h('a', { href: certificateUrl({ receiver: { origin: sent.receiverOrigin } }, sent.certificate.verification_code), target: '_blank', rel: 'noopener' }, 'View your certificate'), h('span.muted.small', ` (${sent.certificate.verification_code})`)));
      if (sent.slimmed) box.append(h('p.small.muted', 'The record was large, so long answers were left out; the scores went through.'));
      box.append(h('p.small.muted', 'A session is sent once. Play again to make a new attempt.'));
      return box;
    }
    if (this.priorSent) {
      box.append(h('p.note', `A play-through of this file was already sent to ${this.priorSent.receiverName ?? ctl.name} on ${fmtWhen(this.priorSent.at)}${typeof this.priorSent.score === 'number' ? ` (score ${this.priorSent.score})` : ''}. `,
        this.priorSent.certificate ? h('a', { href: certificateUrl({ receiver: { origin: this.priorSent.receiverOrigin } }, this.priorSent.certificate.verification_code), target: '_blank', rel: 'noopener' }, 'View that certificate') : null));
    }
    if (!this.moduleId) {
      box.append(h('p.muted', 'This file cannot be recorded: it has no platform module id in its manifest (a bare module.json or a hand-made zip). A file exported from RonuNest carries one.'));
      return box;
    }
    if (this.sendError) box.append(h('p.error', this.sendError));
    if (!ctl.connected) {
      const notice = ctl.takeNotice();
      if (notice) box.append(h('p.error', notice));
    }
    return box.childNodes.length ? box : null;
  }

  renderSendButton() {
    const ctl = this.receiver;
    if (!ctl || !this.moduleId || this.sender?.sent) return null;
    if (!ctl.connected) return h('button.btn.btn-primary', { onclick: async () => { await ctl.connect(); this.render(true); } }, 'Connect to RonuNest to record this');
    if (this.sending) return h('button.btn.btn-primary', { disabled: true }, `Sending to ${ctl.name}…`);
    const label = this.sendError ? 'Try again' : this.priorSent ? `Send this play-through to ${ctl.name} as a new attempt` : `Send to ${ctl.name}`;
    return h(`button.btn${this.priorSent ? '' : '.btn-primary'}`, { onclick: () => this.sendToReceiver() }, label);
  }

  /** Section 3: build the body from the engine and send it once. */
  async sendToReceiver() {
    const ctl = this.receiver;
    if (!ctl?.connected || this.sending) return;
    if (!this.sender || this.sender.client !== ctl.client) this.sender = createRecordSender(ctl.client);
    if (this.sender.sent) return;
    let body;
    try {
      body = buildRecordBody(this.engine, this.manifest);
    } catch (e) {
      this.sendError = e.message;
      this.render(true);
      return;
    }
    this.sending = true;
    this.sendError = null;
    this.render(true);
    try {
      const sent = await this.sender.send(body);
      this.priorSent = null;
      await this.onSent(sent);
    } catch (e) {
      // 401 was refreshed and retried inside the client; a disconnect surfaces through the controller's notice.
      this.sendError = e.code === 'disconnected' ? `${e.message} Your record is kept; connect and send it again.` : e.code === 'network' || e.code === 'server' ? `${e.message} Your record is kept.` : e.message;
      if (e.code === 'disconnected') this.sender = null;
    } finally {
      this.sending = false;
      this.render(true);
    }
  }

  /** A node score's label: the node title, or "Scene title: hotspot label" for an answer given inside a scene. */
  scoreLabel(id) {
    const nodeTitle = (n) => n?.config?.title ?? n?.title ?? null;
    const node = this.engine.nodesById.get(id);
    if (node) return nodeTitle(node) ?? id;
    const slash = id.indexOf('/');
    if (slash > 0) {
      const scene = this.engine.nodesById.get(id.slice(0, slash));
      const hs = (scene?.config?.hotspots ?? []).find((x) => x?.id === id.slice(slash + 1));
      if (scene) return `${nodeTitle(scene) ?? scene.id}: ${hs?.label ?? id.slice(slash + 1)}`;
    }
    return id;
  }
}

/** One line per engine event for the Session record panel. */
function describeEvent(e, engine) {
  const title = (id) => {
    const n = engine.nodesById.get(id);
    return n?.config?.title ?? n?.title ?? id ?? '';
  };
  const hs = (nodeId, hotspotId) => (engine.nodesById.get(nodeId)?.config?.hotspots ?? []).find((x) => x?.id === hotspotId)?.label ?? hotspotId;
  switch (e.type) {
    case 'launched': return 'Started';
    case 'entered': return `Entered "${title(e.nodeId)}"`;
    case 'exited': return `Left "${title(e.nodeId)}"`;
    case 'skipped': return `Skipped "${title(e.nodeId)}" (${e.reason})`;
    case 'answered': return `Answered ${e.hotspotId ? `"${hs(e.nodeId, e.hotspotId)}" in "${title(e.nodeId)}"` : `"${title(e.nodeId)}"`}: ${short(e.texts?.length ? e.texts.join(', ') : e.response)}${typeof e.score === 'number' ? ` (score ${e.score})` : ''}`;
    case 'variable': return `${e.name}: ${short(e.from, 20)} → ${short(e.to, 20)}${e.source ? ` (${e.source})` : ''}`;
    case 'branch': return `"${title(e.nodeId)}" routed to "${title(e.targetNodeId)}"`;
    case 'scene-abort': return `Left "${title(e.nodeId)}" early for "${title(e.targetNodeId)}"`;
    case 'hotspot': return `Found "${e.label || hs(e.nodeId, e.hotspotId)}" in "${title(e.nodeId)}"`;
    case 'hotspot-read': return `Read "${hs(e.nodeId, e.hotspotId)}"`;
    case 'scene-miss': return `Tapped nothing in "${title(e.nodeId)}"`;
    case 'timer-expiry': return `${e.scope === 'module' ? 'Module' : 'Node'} timer ran out (${e.behavior})`;
    case 'onTimerElapsed': return `Timer trigger fired${e.nodeId ? ` in "${title(e.nodeId)}"` : ''}`;
    case 'procedure-step': return `Step ${e.step + 1} done in turn`;
    case 'procedure-misstep': return `Step ${e.step + 1} out of turn${e.critical ? ' (critical)' : ''}`;
    case 'completed': return `Completed: ${e.passed === true ? 'passed' : e.passed === false ? 'not passed' : 'no pass rule'}${typeof e.score === 'number' ? `, score ${e.score}` : ''}`;
    default: return e.type;
  }
}

function describeRule(rule, engine) {
  const mode = rule.mode ?? 'variable';
  if (mode === 'reachedNode') return `Pass rule: reach "${engine.nodesById.get(rule.passNodeId)?.config?.title ?? rule.passNodeId}".`;
  if (mode === 'nodeScore') return `Pass rule: node score ${rule.operator ?? '>='} ${rule.value ?? ''}${rule.scoreNodeId ? ` on "${engine.nodesById.get(rule.scoreNodeId)?.config?.title ?? rule.scoreNodeId}"` : ` (${rule.scoreAggregate ?? 'average'})`}.`;
  const v = engine.findVariable(rule.variableId);
  return `Pass rule: ${v?.name ?? rule.variableId} ${String(rule.operator ?? '').replace(/_/g, ' ')} ${rule.value ?? ''}`.trim() + '.';
}
