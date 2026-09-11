#!/usr/bin/env node
// Every case's module.json must satisfy the reference validator: zero errors,
// warnings allowed (and listed). The exception is a case whose whole point is
// a file the validator rejects but a player must still tolerate (a dangling
// edge, no start node, an unknown node type): its case.json declares the
// exact error codes under `validator.errors`, and this script checks the
// validator reports those and nothing else. So the suite pins the validator's
// verdicts as well as the player's.
//
//   node conformance/validate-cases.mjs
//   RONU_BIN=target/debug/ronu node conformance/validate-cases.mjs   # a prebuilt binary
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadCases, report, cliOptions, REPO_DIR } from './lib/cases.mjs';

function validate(files) {
  const bin = process.env.RONU_BIN;
  const proc = bin
    ? spawnSync(bin, ['validate', '--json', ...files], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    : spawnSync('cargo', ['run', '--quiet', '--manifest-path', join(REPO_DIR, 'rust', 'Cargo.toml'), '--bin', 'ronu', '--', 'validate', '--json', ...files], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (proc.error) throw proc.error;
  const byFile = new Map();
  for (const line of (proc.stdout || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    const row = JSON.parse(t);
    byFile.set(row.file, row);
  }
  if (!byFile.size) throw new Error(`the validator printed nothing parseable\n${proc.stderr}`);
  return byFile;
}

const opts = cliOptions();
const cases = loadCases().filter((c) => !opts.only || c.def.id.includes(opts.only));
const files = cases.map((c) => join(c.dir, 'module.json'));
const rows = validate(files);
const results = cases.map((c, i) => {
  const row = rows.get(files[i]);
  if (!row) return { id: c.def.id, status: 'FAIL', note: 'no validator output for this file' };
  const expected = [...(c.def.validator?.errors ?? [])].sort();
  const actual = row.errors.map((e) => e.code).sort();
  const warnings = row.warnings.map((w) => w.code);
  const diffs = [];
  if (JSON.stringify(expected) !== JSON.stringify(actual)) diffs.push(`errors: expected [${expected.join(', ')}], got [${actual.join(', ')}]`);
  for (const e of row.errors) if (!expected.includes(e.code)) diffs.push(`  ${e.code}: ${e.message}`);
  const note = (expected.length ? `deliberately invalid (${expected.join(', ')})` : 'valid') + (warnings.length ? `; warnings: ${warnings.join(', ')}` : '');
  return { id: c.def.id, status: diffs.length ? 'FAIL' : 'PASS', diffs, note };
});
process.exitCode = report(results, 'Reference validator (rust/) over conformance/cases/*/module.json');
