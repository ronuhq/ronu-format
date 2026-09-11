// Shared by every runner: load the cases, decide which a player may skip,
// check an outcome against a case's `expect`, and print the table.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diff, matchesSubsequence } from './compare.mjs';

export const CONFORMANCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CASES_DIR = join(CONFORMANCE_DIR, 'cases');
export const REPO_DIR = join(CONFORMANCE_DIR, '..');

/** The play steps a case may use, and the outcome keys it may expect. */
export const STEP_KINDS = ['at', 'continue', 'choose', 'answerText', 'answerMultiple', 'answerRanking', 'answerMatching', 'answerRating', 'performStep', 'placeItem', 'submitPlacements', 'activateHotspot', 'tapScene', 'dismissBeat', 'answerConversation', 'elapse'];
export const EXPECT_KEYS = ['trail', 'current', 'variables', 'end', 'nodeScores', 'answers', 'events', 'view'];

/** Every case under conformance/cases, sorted by id. */
export function loadCases(dir = CASES_DIR) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const caseDir = join(dir, entry.name);
    const casePath = join(caseDir, 'case.json');
    const modulePath = join(caseDir, 'module.json');
    if (!existsSync(casePath) || !existsSync(modulePath)) continue;
    const def = JSON.parse(readFileSync(casePath, 'utf8'));
    if (def.id !== entry.name) throw new Error(`${casePath}: id "${def.id}" does not match its folder name`);
    for (const step of def.play ?? []) {
      const kind = Object.keys(step)[0];
      if (!STEP_KINDS.includes(kind)) throw new Error(`${casePath}: unknown play step "${kind}"`);
    }
    for (const key of Object.keys(def.expect ?? {})) {
      if (!EXPECT_KEYS.includes(key)) throw new Error(`${casePath}: unknown expect key "${key}"`);
    }
    const manifestPath = join(caseDir, 'manifest.json');
    out.push({
      dir: caseDir,
      def,
      module: JSON.parse(readFileSync(modulePath, 'utf8')),
      manifest: existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null,
    });
  }
  return out.sort((a, b) => a.def.id.localeCompare(b.def.id));
}

/**
 * May a player with `capabilities` skip this case? `capabilities` is
 * `{level, requires}`: the conformance level it claims (1 or 2) and the set of
 * node types and feature tags it implements. Returns null when the case must
 * be run, else the reason to skip.
 */
export function skipReason(def, capabilities) {
  if ((def.level ?? 1) > (capabilities.level ?? 1)) return `level ${def.level} case; player claims level ${capabilities.level ?? 1}`;
  const have = new Set(capabilities.requires ?? []);
  const missing = (def.requires ?? []).filter((r) => !have.has(r));
  if (missing.length) return `requires ${missing.join(', ')}`;
  return null;
}

/**
 * Check an outcome against `expect`. The outcome is the runner's report of
 * what its player did, in the shape every runner produces:
 *   { trail, current, variables, end?, nodeScores, answers, events, view? }
 * `end` is present only when the play ended; `view` only when it did not.
 * Returns difference strings (empty means PASS).
 */
export function checkExpect(expect, outcome) {
  const out = [];
  for (const [key, expected] of Object.entries(expect ?? {})) {
    switch (key) {
      case 'end':
        if (!outcome.end) out.push('$.end: the play did not end');
        else out.push(...diff(expected, outcome.end, '$.end'));
        break;
      case 'view':
        if (!outcome.view) out.push('$.view: the play ended, there is no node to view');
        else out.push(...diff(expected, outcome.view, '$.view'));
        break;
      case 'events':
        out.push(...matchesSubsequence(expected, outcome.events ?? [], '$.events'));
        break;
      default:
        out.push(...diff(expected, outcome[key], `$.${key}`));
    }
  }
  return out;
}

const pad = (s, n) => String(s).padEnd(n);

/** Print the per-case table and a summary line; return the exit code. */
export function report(results, label) {
  const width = Math.max(...results.map((r) => r.id.length), 4);
  console.log(`\n${label}\n${'='.repeat(label.length)}`);
  for (const r of results) {
    console.log(`${pad(r.status, 5)} ${pad(r.id, width)}  ${r.note ?? ''}`.trimEnd());
    for (const d of r.diffs ?? []) console.log(`      ${d}`);
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  const summary = `${results.length} cases: ${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped`;
  console.log(`\n${summary}\n`);
  return count('FAIL') ? 1 : 0;
}

/** `--only <substring>` filter and `--verbose` from argv. */
export function cliOptions(argv = process.argv.slice(2)) {
  const opts = { only: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') opts.only = argv[++i] ?? '';
    else if (argv[i] === '--verbose' || argv[i] === '-v') opts.verbose = true;
  }
  return opts;
}
