// The conversation loop through a receiver (docs/record-receiver.md section 4)
// against a fake endpoint: the first message, a turn, the degraded stop, the
// finalize that writes the score variable and records the answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../engine.js';
import { ReceiverClient } from '../receiver.js';
import { ConversationRun, attachConversation, attachHotspotConversation, DEFAULT_MAX_TURNS } from '../conversation.js';
import { loadSample, fakeClock } from './helpers.mjs';

const NOW = 1_800_000_000_000;

function connection() {
  return {
    receiver: { name: 'Mock', origin: 'https://receiver.test', supabaseUrl: 'https://db.test', anonKey: 'anon-key', records: 'https://db.test/functions/v1/record-completion', conversation: 'https://db.test/functions/v1/ai-conversation' },
    session: { access_token: 'access-1', refresh_token: 'refresh-1', expires_at: Math.floor(NOW / 1000) + 3600, token_type: 'bearer' },
    user: { id: 'u1', email: 'learner@example.com', name: 'Learner' },
  };
}

/**
 * A fake ai-conversation endpoint: replies "Reply n" with the first mood
 * state; `degrade` in a learner line trips the degraded reply; `fail` makes
 * the call 500; finalize returns an assessment (wrapped, as the platform does).
 */
function fakeConversationFetch({ score = 80 } = {}) {
  const calls = [];
  let n = 0;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const last = body.messages[body.messages.length - 1];
    const reply = (status, json) => ({ ok: status < 300, status, text: async () => JSON.stringify(json) });
    if (last?.content?.includes('fail')) return reply(500, { error: 'The conversation hit a problem. Please try again.' });
    if (body.finalize) {
      const criteria = Array.isArray(body.criteria) ? body.criteria.map((c) => ({ id: c.id, score, comment: `about ${c.label}` })) : undefined;
      return reply(200, { assessment: { score, summary: 'Clear, honest, unhurried.', ...(criteria ? { criteria } : {}), model: 'fake', promptVersion: '0', gradedAt: '2027-01-15T08:00:00.000Z' }, degraded: false, usage: { used: n, limit: 100 } });
    }
    if (last?.role !== 'learner') return reply(400, { error: 'Nothing to reply to.' });
    n += 1;
    if (last.content.includes('degrade')) return reply(200, { reply: 'Sorry, I need to wrap up here.', mood: body.moodStates[0]?.label ?? 'neutral', degraded: true, capped: false, usage: { used: n, limit: n } });
    return reply(200, { reply: `Reply ${n}`, mood: body.moodStates[0]?.label ?? 'neutral', degraded: false, usage: { used: n, limit: 100 } });
  };
  fetch.calls = calls;
  return fetch;
}

function setup(sample = 'barrier-cream-round', fetchOpts) {
  const now = fakeClock(NOW);
  const fetch = fakeConversationFetch(fetchOpts);
  const client = new ReceiverClient(connection(), { fetch, now });
  const { module, manifest } = loadSample(sample);
  const e = new Engine(module, { now, services: { conversation: true } });
  return { now, fetch, client, e, manifest };
}

/** Walk barrier-cream-round to its conversation node cleanly. */
function toConversation(e) {
  let v = e.start();
  v = e.continue();
  for (const it of v.config.dragItems) if (it.targetId) e.placeItem(it.id, it.targetId);
  e.submitPlacements();
  v = e.continue();
  for (let i = 0; i < 7; i++) e.performStep(i);
  v = e.continue();
  assert.equal(v.type, 'conversation');
  return v;
}

test('the character opens with firstMessage; a turn sends the section 4 body and appends the reply with its mood', async () => {
  const { fetch, client, e, manifest } = setup();
  const view = toConversation(e);
  const changes = [];
  const run = attachConversation(e, client, view, { moduleId: manifest.module.versionId, onChange: (r) => changes.push(r.status) });
  assert.deepEqual(run.messages, [{ role: 'character', content: view.config.firstMessage }]);
  assert.equal(run.maxTurns, 5);
  assert.equal(run.turnsLeft, 5);
  assert.equal(run.canSend, true);
  assert.equal(run.canEnd, false, 'nothing said yet');

  const turn = await run.send('  It is a barrier cream for her heels, to protect the skin.  ');
  assert.equal(turn.reply, 'Reply 1');
  assert.deepEqual(changes, ['replying', 'open']);
  assert.equal(fetch.calls.length, 1);
  const { url, headers, body } = fetch.calls[0];
  assert.equal(url, 'https://db.test/functions/v1/ai-conversation');
  assert.equal(headers.Authorization, 'Bearer access-1');
  assert.equal(headers.apikey, 'anon-key');
  assert.deepEqual(body, {
    version: 0,
    persona: view.config.persona,
    objective: view.config.objective,
    moodStates: [],
    messages: [
      { role: 'character', content: view.config.firstMessage },
      { role: 'learner', content: 'It is a barrier cream for her heels, to protect the skin.' },
    ],
    finalize: false,
    moduleId: 'c4d1a2e6-8b3f-4f7a-9d21-5e6f7a8b9c0d',
  });
  assert.equal(run.messages.length, 3);
  assert.deepEqual(run.messages[2], { role: 'character', content: 'Reply 1', mood: 'neutral' });
  assert.equal(run.turnsLeft, 4);
  assert.equal(run.canEnd, true);
  assert.deepEqual(run.usage, { used: 1, limit: 100 });
  assert.equal(e.view().state.answered, false, 'nothing recorded until the conversation ends');
});

test('mood states come from config.visual.states and the reply carries the label', async () => {
  const { fetch, client } = setup();
  const run = new ConversationRun({ config: { persona: 'p', firstMessage: 'hi', visual: { states: [{ id: 's1', label: 'Warm', cue: 'smiling', sprite: 'x.png' }, { id: 's2', label: 'Wary' }, { label: '' }] } }, moduleId: null, client });
  await run.send('hello');
  assert.deepEqual(fetch.calls[0].body.moodStates, [{ label: 'Warm', cue: 'smiling' }, { label: 'Wary' }]);
  assert.equal(fetch.calls[0].body.moduleId, undefined, 'no module id: the field is left out');
  assert.equal(run.messages[2].mood, 'Warm');
  assert.equal(run.maxTurns, DEFAULT_MAX_TURNS);
});

test('degraded: the turn loop ends, the learner can only end and assess', async () => {
  const { client, e, manifest } = setup();
  const view = toConversation(e);
  const run = attachConversation(e, client, view, { moduleId: manifest.module.versionId });
  await run.send('please degrade');
  assert.equal(run.status, 'degraded');
  assert.equal(run.degraded, true);
  assert.equal(run.turnsLeft, 0);
  assert.equal(run.canSend, false);
  assert.equal(run.canEnd, true);
  assert.equal(run.messages[2].content, 'Sorry, I need to wrap up here.');
  assert.equal(await run.send('more'), null, 'no further turns');
  assert.equal(run.messages.length, 3);
});

test('finalize sends the transcript with the rubric, writes the score variable, records the answer, and unlocks Continue', async () => {
  const { fetch, client, e, manifest } = setup('barrier-cream-round', { score: 72 });
  const view = toConversation(e);
  const run = attachConversation(e, client, view, { moduleId: manifest.module.versionId });
  await run.send('Barrier cream, on her heels. She said yes before I started.');
  const a = await run.end();
  assert.equal(run.status, 'done');
  assert.equal(run.done, true);
  const fin = fetch.calls[1].body;
  assert.equal(fin.finalize, true);
  assert.equal(fin.messages.length, 3);
  assert.deepEqual(fin.criteria, view.config.rubric.map((c) => ({ id: c.id, label: c.label, weight: c.weight })));
  assert.equal(fin.moduleId, 'c4d1a2e6-8b3f-4f7a-9d21-5e6f7a8b9c0d');
  assert.equal(a.score, 72);
  assert.equal(a.summary, 'Clear, honest, unhurried.');
  assert.equal(a.criteria.length, 3);
  assert.equal(a.criteria[0].comment, 'about Explained what the cream is for, in plain words');
  assert.equal(a.model, 'fake');

  // Into the engine: the score variable, the answer with score, the event, Continue.
  const vars = Object.fromEntries(e.variables().map((v) => [v.name, v.value]));
  assert.equal(vars.explain_score, 72);
  assert.equal(e.responses.explain.score, 72);
  assert.deepEqual(e.responses.explain.response.messages, run.messages);
  assert.equal(e.responses.explain.response.assessment.score, 72);
  assert.equal(e.nodeScores.explain, 72);
  assert.ok(e.events.some((x) => x.type === 'answered' && x.nodeId === 'explain' && x.score === 72));
  assert.ok(e.events.some((x) => x.type === 'variable' && x.variableId === 'explain_score' && x.to === 72 && x.source === 'conversation'));
  assert.equal(e.view().canContinue, true);
  let v = e.continue();
  assert.equal(v.node.id, 'done');
  v = e.continue();
  assert.equal(v.result.passed, true, 'explain_score >= 60');
  // Ending twice, or answering the engine twice, changes nothing.
  assert.equal(await run.end(), null);
  e.start();
});

test('reaching maxTurns finalises by itself', async () => {
  const { fetch, client } = setup();
  const run = new ConversationRun({ config: { persona: 'p', firstMessage: 'hi', maxTurns: 2 }, moduleId: null, client });
  await run.send('one');
  assert.equal(run.status, 'open');
  await run.send('two');
  assert.equal(run.status, 'done', 'the last allowed turn ends and assesses');
  assert.equal(fetch.calls.length, 3);
  assert.equal(fetch.calls[2].body.finalize, true);
  assert.equal(run.assessment.score, 80);
});

test('a failed turn hands the line back as the draft; a failed finalize can be retried; the fallback card lets the learner continue', async () => {
  const { client, e, manifest } = setup();
  const view = toConversation(e);
  const run = attachConversation(e, client, view, { moduleId: manifest.module.versionId });
  await run.send('this will fail');
  assert.equal(run.status, 'open');
  assert.equal(run.messages.length, 1, 'the learner line was withdrawn');
  assert.equal(run.draft, 'this will fail');
  assert.match(run.error, /hit a problem/);
  assert.equal(run.errorCode, 'server');
  await run.send('fine now');
  assert.equal(run.messages.length, 3);
  assert.equal(run.error, null);
  // A finalize that fails leaves the run open with the error; the engine is untouched.
  run.messages.push({ role: 'learner', content: 'fail' });
  await run.end();
  assert.equal(run.status, 'open');
  assert.match(run.error, /hit a problem/);
  assert.equal(e.view().state.answered, false);
  assert.equal(e.view().canContinue, false);
  // The learner gives up on the character: the spec's fallback, then Continue.
  e.conversationFallback();
  assert.equal(e.view().canContinue, true);
  assert.equal(e.continue().node.id, 'done');
  assert.equal(e.responses.explain, undefined, 'no answer, no score: the variable keeps its initial value');
});

test('without a receiver the node is unsupported and Continue works as before; connecting mid-node makes it live', () => {
  const { module } = loadSample('barrier-cream-round');
  const e = new Engine(module);
  toConversation(e);
  let v = e.view();
  assert.equal(v.supported, false);
  assert.equal(v.canContinue, true);
  e.setServices({ conversation: true });
  v = e.view();
  assert.equal(v.supported, true);
  assert.equal(v.canContinue, false);
  e.setServices({ conversation: false });
  assert.equal(e.view().canContinue, true);
});

test('a hotspot character in a scene: assessed against <sceneId>/<hotspotId>, score variable written, later beats wait until it is ended', async () => {
  const { client, e } = setup('margarets-room', { score: 90 });
  let v = e.start();
  v = e.continue();
  assert.equal(v.type, 'scene');
  const hs = e.sceneHotspots(v.node).find((h) => h.id === 'h-margaret');
  e.activateHotspot('h-margaret');
  v = e.view();
  assert.equal(v.state.beat.kind, 'conversation');
  // Closing a live, unfinished character returns to the room and drops the later beats (G41).
  e.dismissBeat();
  assert.equal(e.view().state.beat, null);
  e.activateHotspot('h-margaret');
  const run = attachHotspotConversation(e, client, e.view(), hs, { moduleId: null });
  assert.equal(run.messages[0].content, 'Morning, love. What are you after?');
  assert.equal(run.maxTurns, 4);
  await run.send('Morning Margaret, I am here to do your heel cream. Is that all right?');
  await run.end();
  assert.equal(run.assessment.criteria.length, 3, 'a hotspot rubric is called criteria');
  assert.equal(e.responses['room/h-margaret'].score, 90);
  assert.equal(e.nodeScores['room/h-margaret'], 90);
  assert.equal(Object.fromEntries(e.variables().map((x) => [x.name, x.value])).consent_score, 90);
  assert.ok(e.events.some((x) => x.type === 'answered' && x.nodeId === 'room' && x.hotspotId === 'h-margaret' && x.score === 90));
  assert.equal(e.hotspotConversationState('h-margaret').answered, true);
  e.dismissBeat();
  assert.equal(e.currentNodeId, 'room', 'no route on this hotspot; back in the room');
  // The fallback path for a hotspot character also lets the beats run.
  e.activateHotspot('h-margaret');
  e.hotspotConversationFallback('h-margaret');
  e.dismissBeat();
  assert.equal(e.view().state.beat, null);
});
