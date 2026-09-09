// Zips one of the unzipped interchange samples into a real .ronu, using the
// vendored fflate. Used to build the test fixture and handy for trying the
// player with the other samples.
//
//   node player/tools/zip-sample.mjs samples/under-the-sink player/test/fixtures/under-the-sink.ronu

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const fflate = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'fflate.js'));

const [srcDir, outFile] = process.argv.slice(2);
if (!srcDir || !outFile) {
  console.error('usage: zip-sample.mjs <sample dir> <out.ronu>');
  process.exit(2);
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (!name.startsWith('.') && !name.endsWith('.ronu')) acc.push(p);
  }
  return acc;
}

const entries = {};
for (const file of walk(srcDir)) {
  const rel = relative(srcDir, file).split(/[\\/]/).join('/');
  entries[rel] = [readFileSync(file), { level: rel.endsWith('.json') ? 6 : 0 }];
}
if (!entries['module.json']) throw new Error('module.json not found in ' + srcDir);
if (!entries['manifest.json']) throw new Error('manifest.json not found in ' + srcDir);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, fflate.zipSync(entries));
console.log('wrote', outFile, Object.keys(entries).join(', '));
