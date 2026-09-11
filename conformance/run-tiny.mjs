#!/usr/bin/env node
// Drives the tutorial player (docs/examples/tiny-player.mjs) through the cases
// it can play: those whose `requires` stay within message, choice, condition
// and note. It is a second, independent implementation, so agreement with the
// reference on these cases is evidence the case files pin behaviour and not
// one engine's habits.
//
// The tiny player is a terminal program with no API, so this runner is an
// adapter of the black-box kind: `choose` steps become the ANSWERS index list
// it reads from the environment, and the end state it prints ("name = value"
// lines and the pass line) is what gets compared. It checks `variables` and
// `end.passed` only; the other expect keys are not something it prints.
//
//   node conformance/run-tiny.mjs [--only <substring>] [--verbose]
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadCases, skipReason, report, cliOptions, REPO_DIR } from './lib/cases.mjs';
import { diff } from './lib/compare.mjs';

export const TINY_PLAYER = join(REPO_DIR, 'docs', 'examples', 'tiny-player.mjs');

// What docs/build-a-player.md promises: the skeleton, the branching
// primitives, variables and actions. No triggers (it fires onNodeExit only),
// no timers, no computed variables, no coercion rules, nothing to answer.
export const CAPABILITIES = { level: 1, requires: ['message', 'choice', 'condition', 'note'] };

/** The 1-based choice index for each `choose` step, in play order. */
export function answersFor(def, module) {
  const out = [];
  for (const s of def.play ?? []) {
    if (!('choose' in s)) continue;
    let index = -1;
    for (const n of module.nodes ?? []) {
      const choices = n.config?.choices;
      if (!Array.isArray(choices)) continue;
      const i = choices.findIndex((c) => c && c.id === s.choose);
      if (i >= 0) { index = i; break; }
    }
    if (index < 0) throw new Error(`choice ${s.choose} is in no node`);
    out.push(index + 1);
  }
  return out;
}

/** Parse the end state the tiny player prints. */
export function parseEnd(stdout, module) {
  const lines = stdout.split('\n');
  const at = lines.findIndex((l) => l.trim() === '=== End ===');
  const variables = {};
  let passed = null;
  if (at < 0) return { variables, passed, ended: false };
  const types = Object.fromEntries((module.variables ?? []).map((v) => [v.name, v.type]));
  for (const line of lines.slice(at + 1)) {
    const pass = line.match(/^\s*pass rule: .* -> (PASSED|not passed)\s*$/);
    if (pass) { passed = pass[1] === 'PASSED'; continue; }
    const m = line.match(/^\s{2}([A-Za-z0-9_]+) = (.*)$/);
    if (!m) continue;
    const [, name, raw] = m;
    const type = types[name];
    variables[name] = type === 'number' ? Number(raw) : type === 'boolean' ? raw === 'true' : raw;
  }
  return { variables, passed, ended: true };
}

export function runCase(c, opts = {}) {
  const skip = skipReason(c.def, CAPABILITIES);
  if (skip) return { id: c.def.id, status: 'SKIP', note: skip };
  const expect = c.def.expect ?? {};
  const rule = c.module.settings?.completion;
  const mode = rule ? (rule.mode || 'variable') : null;
  if (expect.end && 'passed' in expect.end && expect.end.passed !== null && mode !== 'variable') {
    return { id: c.def.id, status: 'SKIP', note: `tiny player prints a pass line for variable-mode rules only (this rule is ${mode})` };
  }
  const checks = ['variables', 'end.passed'].filter((k) => (k === 'variables' ? expect.variables : expect.end && 'passed' in expect.end));
  if (!checks.length) return { id: c.def.id, status: 'SKIP', note: 'checks nothing the tiny player prints (variables, pass line)' };

  const answers = answersFor(c.def, c.module);
  const env = { ...process.env, ANSWERS: answers.length ? answers.join(',') : '1' };
  const proc = spawnSync(process.execPath, [TINY_PLAYER, join(c.dir, 'module.json')], { env, encoding: 'utf8', timeout: 20_000 });
  if (proc.status !== 0) return { id: c.def.id, status: 'FAIL', note: `exit ${proc.status}: ${(proc.stderr || '').trim().split('\n')[0]}` };
  const got = parseEnd(proc.stdout, c.module);
  if (!got.ended) return { id: c.def.id, status: 'FAIL', note: 'never printed === End ===' };
  const diffs = [];
  if (expect.variables) diffs.push(...diff(expect.variables, got.variables, '$.variables'));
  if (expect.end && 'passed' in expect.end) diffs.push(...diff(expect.end.passed, got.passed, '$.end.passed'));
  const r = { id: c.def.id, status: diffs.length ? 'FAIL' : 'PASS', diffs, note: `checked ${checks.join(', ')}` };
  if (opts.verbose) r.note += ` ${JSON.stringify(got)}`;
  return r;
}

const isMain = Boolean(process.argv[1] && process.argv[1].endsWith('run-tiny.mjs'));
if (isMain) {
  const opts = cliOptions();
  const cases = loadCases().filter((c) => !opts.only || c.def.id.includes(opts.only));
  const results = cases.map((c) => runCase(c, opts));
  process.exitCode = report(results, `Tutorial player (docs/examples/tiny-player.mjs) at ${REPO_DIR}`);
}
