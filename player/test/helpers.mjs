import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const PLAYER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = join(PLAYER_DIR, '..');
export const SAMPLES_DIR = join(REPO_DIR, 'samples');

const require = createRequire(import.meta.url);
export const fflate = require(join(PLAYER_DIR, 'vendor', 'fflate.js'));

export function loadSample(name) {
  const dir = join(SAMPLES_DIR, name);
  const module = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
  const manifestPath = join(dir, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  return { module, manifest, dir };
}

export function sampleNames() {
  return readdirSync(SAMPLES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SAMPLES_DIR, d.name, 'module.json')))
    .map((d) => d.name)
    .sort();
}

/** A controllable clock for timer tests. */
export function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

/** Minimal module builder for focused tests. */
export function mod({ nodes, variables = [], settings = {} }) {
  return { nodes, variables, settings };
}

export const msg = (id, connection, extra = {}) => ({ id, type: 'message', title: id, connection, config: { title: id, content: `<p>${id}</p>`, ...extra } });
