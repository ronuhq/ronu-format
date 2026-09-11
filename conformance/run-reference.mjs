#!/usr/bin/env node
// Drives the reference engine (player/engine.js) through every conformance
// case and prints PASS/FAIL/SKIP per case. Exits 1 on any FAIL. This is the
// runner other adapters copy: `step` maps a play step to an engine call,
// `outcome` maps engine state to the shape `checkExpect` reads.
//
//   node conformance/run-reference.mjs            # every case
//   node conformance/run-reference.mjs --only scenes   # a subset, by id substring
//   node conformance/run-reference.mjs --verbose  # print each outcome
import { join } from 'node:path';
import { Engine } from '../player/engine.js';
import { loadCases, skipReason, checkExpect, report, cliOptions, REPO_DIR } from './lib/cases.mjs';

// The reference implements every node type and every feature tag the cases use.
export const CAPABILITIES = {
  level: 2,
  requires: ['message', 'video', 'choice', 'textInput', 'multipleChoice', 'ranking', 'matching', 'rating', 'condition', 'note', 'scene',
    'procedure', 'dragToTarget', 'conversation',
    'triggers', 'timers', 'clock', 'computed', 'placeholders', 'coercion'],
};

/** A controllable clock so `elapse` steps are deterministic. */
function fakeClock(startMs = 1_000_000) {
  let t = startMs;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

/** Apply one play step to the engine. Throws on a step the engine rejects. */
export function step(engine, clock, s) {
  const [kind, arg] = Object.entries(s)[0];
  switch (kind) {
    case 'at': return engine.start();
    case 'continue': return engine.continue();
    case 'choose': return engine.choose(arg);
    case 'answerText': return engine.answerText(arg);
    case 'answerMultiple': return engine.answerMultiple(arg);
    case 'answerRanking': return engine.answerRanking(arg);
    case 'answerMatching': return engine.answerMatching(arg);
    case 'answerRating': return engine.answerRating(arg);
    case 'performStep': return engine.performStep(arg);
    case 'placeItem': return engine.placeItem(arg[0], arg[1] ?? null);
    case 'submitPlacements': return engine.submitPlacements();
    case 'activateHotspot': return engine.activateHotspot(arg);
    case 'tapScene': return engine.tapScene(arg);
    case 'dismissBeat': return engine.dismissBeat();
    case 'answerConversation': {
      const body = { messages: arg.messages ?? [], assessment: { score: arg.score, summary: arg.summary ?? '' } };
      if (arg.hotspot) return engine.answerHotspotConversation(arg.hotspot, body);
      return engine.answerConversation(body);
    }
    case 'elapse':
      clock.advance(Math.round(Number(arg) * 1000));
      return engine.tick();
    default:
      throw new Error(`unknown step ${kind}`);
  }
}

/** The engine's state in the shape checkExpect reads. */
export function outcome(engine) {
  const view = engine.view();
  const out = {
    trail: engine.trail.slice(),
    current: engine.currentNodeId,
    variables: Object.fromEntries(engine.variables().map((v) => [v.name, v.value])),
    nodeScores: { ...engine.nodeScores },
    answers: Object.fromEntries(Object.entries(engine.responses).map(([id, r]) => [id, r.response])),
    events: engine.events,
  };
  if (engine.ended) {
    out.end = { passed: engine.result.passed, score: engine.result.score, reason: engine.result.reason, error: engine.error != null };
  } else if (view.kind === 'node') {
    out.view = { nodeId: view.node.id, type: view.type, title: view.title, content: view.content, question: view.question, instructions: view.instructions, canContinue: view.canContinue, supported: view.supported };
  }
  return out;
}

export function runCase(c) {
  const skip = skipReason(c.def, CAPABILITIES);
  if (skip) return { id: c.def.id, status: 'SKIP', note: skip };
  const clock = fakeClock();
  let engine;
  try {
    engine = new Engine(c.module, { now: clock, services: { conversation: (c.def.requires ?? []).includes('conversation') } });
    for (const s of c.def.play ?? []) step(engine, clock, s);
  } catch (err) {
    return { id: c.def.id, status: 'FAIL', note: `threw: ${err.message}`, outcome: engine ? outcome(engine) : null };
  }
  const got = outcome(engine);
  const diffs = checkExpect(c.def.expect, got);
  return { id: c.def.id, status: diffs.length ? 'FAIL' : 'PASS', diffs, outcome: got };
}

const isMain = Boolean(process.argv[1] && process.argv[1].endsWith('run-reference.mjs'));
if (isMain) {
  const opts = cliOptions();
  const cases = loadCases().filter((c) => !opts.only || c.def.id.includes(opts.only));
  const results = cases.map((c) => {
    const r = runCase(c);
    if (opts.verbose && r.outcome) r.note = `${r.note ?? ''} ${JSON.stringify({ ...r.outcome, events: undefined })}`.trim();
    return r;
  });
  process.exitCode = report(results, `Reference player (player/engine.js) at ${REPO_DIR}`);
}
