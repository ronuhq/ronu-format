#!/usr/bin/env node
// The smallest honest .ronu player: a terminal walk-through of a module.
//
// This is the code from docs/build-a-player.md. It implements the skeleton
// (spec sections 2 to 6), the branching primitives (message, choice,
// condition), variables and actions, and the two evolution rules a player
// must never break: unknown fields are ignored, unknown node types show a
// placeholder and follow their connection. Everything else is left for you.
//
//   node docs/examples/tiny-player.mjs samples/hello-ronu/hello.ronu
//   node docs/examples/tiny-player.mjs samples/under-the-sink/module.json
//   ANSWERS=1,1,1 node docs/examples/tiny-player.mjs samples/hello-ronu/hello.ronu   # scripted
//
// No dependencies beyond Node 20+ (zip reading uses the built-in zlib).

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

// ---- 1. Open the file (spec section 2: a zip with module.json inside) -------

function unzip(bytes) {
  // Minimal zip reader: walk the central directory, inflate each entry.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const lnameLen = view.getUint16(local + 26, true);
    const lextraLen = view.getUint16(local + 28, true);
    const start = local + 30 + lnameLen + lextraLen;
    const raw = bytes.subarray(start, start + csize);
    files[name] = method === 8 ? inflateRawSync(raw) : raw;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function open(path) {
  const bytes = readFileSync(path);
  if (path.endsWith('.json')) return { module: JSON.parse(bytes.toString('utf8')), manifest: null };
  const files = unzip(new Uint8Array(bytes));
  const text = (n) => (files[n] ? new TextDecoder().decode(files[n]) : null);
  const moduleText = text('module.json');
  if (!moduleText) throw new Error('no module.json in the zip');
  return { module: JSON.parse(moduleText), manifest: files['manifest.json'] ? JSON.parse(text('manifest.json')) : null };
}

// ---- 2. State: variables (spec section 4) ---------------------------------

function initialVariables(module) {
  const vars = new Map();
  for (const v of module.variables ?? []) {
    const value = v.initialValue ?? (v.type === 'number' ? 0 : v.type === 'boolean' ? false : '');
    vars.set(v.id, { ...v, value });
  }
  return vars;
}

function applyActions(vars, actions) {
  for (const a of actions ?? []) {
    const v = vars.get(a.variableId);
    if (!v) continue; // must-ignore: an action on a variable we do not know
    const n = Number(a.value ?? 1);
    switch (a.operator) {
      case 'set': v.value = v.type === 'number' ? Number(a.value) : a.value; break;
      case 'increment': v.value = Number(v.value) + (Number.isFinite(n) ? n : 1); break;
      case 'decrement': v.value = Number(v.value) - (Number.isFinite(n) ? n : 1); break;
      case 'multiply': v.value = Number(v.value) * n; break;
      case 'divide': if (n !== 0) v.value = Number(v.value) / n; break;
      case 'set_true': v.value = true; break;
      case 'set_false': v.value = false; break;
      case 'toggle': v.value = !v.value; break;
      default: /* unknown operator: ignore, per section 5.1 */
    }
  }
}

function fill(text, vars) {
  // {variableName} placeholders (spec section 7, shared sub-schemas).
  return String(text ?? '').replace(/\{([A-Za-z0-9_]+)\}/g, (m, name) => {
    for (const v of vars.values()) if (v.name === name) return String(v.value);
    return m;
  });
}

// ---- 3. Conditions (spec section 7 `condition`, section 8 legacy form) ------

function conditionConfig(node) {
  const c = node.config ?? {};
  if (c.criteria && typeof c.criteria === 'object') return c.criteria; // canonical
  if (typeof c.choices === 'string') { try { return JSON.parse(c.choices); } catch { /* fall through */ } } // legacy
  return { criteriaSets: [] };
}

function holds(cond, vars, answers) {
  const byName = [...vars.values()].find((v) => v.name === cond.field);
  const v = vars.get(cond.field) ?? byName;
  const actual = v ? v.value : answers.get(cond.field);
  const op = String(cond.operator ?? '').replace(/_/g, ' ');
  const want = cond.value;
  switch (op) {
    case 'is true': return actual === true || actual === 'true';
    case 'is false': return actual === false || actual === 'false';
    case 'equals': return String(actual) === String(want);
    case 'not equals': return String(actual) !== String(want);
    case 'contains': return String(actual ?? '').includes(String(want));
    case '>': return Number(actual) > Number(want);
    case '<': return Number(actual) < Number(want);
    case '>=': return Number(actual) >= Number(want);
    case '<=': return Number(actual) <= Number(want);
    case 'exists': return actual !== undefined && actual !== null && actual !== '';
    default: return false; // an operator this player does not know never matches
  }
}

function route(node, vars, answers) {
  const cfg = conditionConfig(node);
  for (const set of cfg.criteriaSets ?? []) {
    // Conditions whose field is the literal "operator" are AND/OR joiners;
    // this tiny player treats every set as AND (see SPEC-GAPS G3).
    const real = (set.conditions ?? []).filter((c) => c.field !== 'operator');
    if (real.length && real.every((c) => holds(c, vars, answers))) return set.targetNodeId;
  }
  return cfg.defaultTargetNodeId ?? node.connection ?? null;
}

// ---- 4. The walk (spec section 4: start node, connections) -----------------

async function play(path, scripted) {
  const { module, manifest } = open(path);
  const nodes = new Map((module.nodes ?? []).map((n) => [n.id, n]));
  const vars = initialVariables(module);
  const answers = new Map();
  const rl = scripted ? null : createInterface({ input: stdin, output: stdout });
  const ask = async (prompt, max) => {
    if (scripted) { const a = Number(scripted.shift() ?? 1); return Math.min(Math.max(a, 1), max) - 1; }
    for (;;) {
      const a = Number(await rl.question(`${prompt} [1-${max}] `));
      if (a >= 1 && a <= max) return a - 1;
    }
  };

  console.log(`\n=== ${manifest?.module?.title ?? module.settings?.title ?? path} ===\n`);
  let current = (module.nodes ?? []).find((n) => n.config?.isStart) ?? module.nodes?.[0];
  let guard = 0;
  while (current && guard++ < 500) {
    const cfg = current.config ?? {};
    let next = current.connection ?? cfg.connection ?? null;
    // Legacy in, canonical out (spec section 8): old files say `router` and
    // `decisionPath`; readers must treat them as `choice` and `condition`.
    const type = { router: 'choice', decisionPath: 'condition' }[current.type] ?? current.type;
    switch (type) {
      case 'message':
        console.log(`\n# ${fill(current.title, vars)}\n${fill(cfg.content ?? '', vars).replace(/<[^>]+>/g, '')}\n`);
        break;
      case 'choice': {
        console.log(`\n? ${fill(cfg.question ?? current.title, vars)}`);
        (cfg.choices ?? []).forEach((c, i) => console.log(`  ${i + 1}. ${fill(c.text, vars)}`));
        const pick = (cfg.choices ?? [])[await ask('>', cfg.choices?.length ?? 1)];
        if (pick) { answers.set(current.id, pick.text); applyActions(vars, pick.actions); next = pick.connection ?? next; }
        break;
      }
      case 'condition':
        next = route(current, vars, answers);
        break;
      case 'note':
        break; // canvas-only, skipped (spec section 7)
      default:
        // Evolution rule 5.2: a type we do not know is a placeholder that
        // follows its connection. That is how a player from today plays a
        // file from next year.
        console.log(`\n[${current.type}] ${fill(current.title, vars)} (not supported by this player, continuing)\n`);
    }
    applyActions(vars, (cfg.triggers ?? []).filter((t) => t.type === 'onNodeExit').flatMap((t) => t.actions ?? []));
    current = next ? nodes.get(next) : null;
    if (next && !current) console.log(`(dangling connection to ${next}, ending)`);
  }

  console.log('\n=== End ===');
  for (const v of vars.values()) console.log(`  ${v.name} = ${v.value}`);
  const rule = module.settings?.completion;
  if (rule?.variableId && vars.has(rule.variableId)) {
    const v = vars.get(rule.variableId);
    const op = rule.operator ?? '>=';
    const passed = holds({ field: rule.variableId, operator: op, value: rule.value }, vars, answers);
    console.log(`  pass rule: ${v.name} ${op}${rule.value === undefined ? '' : ' ' + rule.value} -> ${passed ? 'PASSED' : 'not passed'}`);
  }
  rl?.close();
}

const file = process.argv[2];
if (!file) { console.error('usage: tiny-player.mjs <file.ronu | module.json>'); process.exit(2); }
const scripted = process.env.ANSWERS ? process.env.ANSWERS.split(',') : null;
await play(file, scripted);
