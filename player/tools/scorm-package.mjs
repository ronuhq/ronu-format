#!/usr/bin/env node
// Build a self-contained SCORM 1.2 package from a .ronu file: the reference
// player, the file, a launcher and an imsmanifest.xml, zipped. Node 20+, no
// npm; the vendored fflate does the zipping. The XML and the file list come
// from scorm-manifest.mjs, which the tests exercise directly.
//
//   node player/tools/scorm-package.mjs <file.ronu> [--title "..."] [--out <zip>] [--identifier <id>]
//   node player/tools/scorm-package.mjs <file.ronu> --receiver https://ronunest.com --key <customer API key>
//
// The second form builds a connected package: the same zip plus
// ronu-package.json (the receiver and the key, contract section 7), and a
// launcher that asks for the machine launch, so the LMS's learner is
// connected without a popup or an account.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildPackageEntries, XSD_FILES } from './scorm-manifest.mjs';

const require = createRequire(import.meta.url);
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const PLAYER_DIR = join(TOOLS_DIR, '..');
const XSD_DIR = join(TOOLS_DIR, 'scorm-xsd');
const fflate = require(join(PLAYER_DIR, 'vendor', 'fflate.js'));

function usage(code) {
  console.error('usage: scorm-package.mjs <file.ronu> [--title "..."] [--out <zip>] [--identifier <id>]');
  console.error('       scorm-package.mjs <file.ronu> --receiver <origin> --key <customer API key> [--player-name "..."]  (a connected package)');
  process.exit(code);
}

export function parseArgs(argv) {
  const out = { file: null, title: null, out: null, identifier: null, receiver: null, key: null, connected: false, playerName: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--title') out.title = argv[++i] ?? null;
    else if (a === '--out') out.out = argv[++i] ?? null;
    else if (a === '--identifier') out.identifier = argv[++i] ?? null;
    else if (a === '--receiver') out.receiver = argv[++i] ?? null;
    else if (a === '--key') out.key = argv[++i] ?? null;
    else if (a === '--player-name') out.playerName = argv[++i] ?? null;
    else if (a === '--connected') out.connected = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (!out.file) out.file = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return out;
}

export const CONNECTED_HELP = 'A connected package needs both --receiver <origin> and --key <key>. The key is a customer API key from RonuNest (nest settings, Portal API keys): issue one per LMS customer, and revoke it there to cut the package off.';

/**
 * The connected-package options, or null for a self-contained package.
 * `--receiver` and `--key` go together; `--connected` alone, or one of the
 * two, is an error that says what is missing.
 */
export function connectedOptions(args) {
  const receiver = typeof args.receiver === 'string' && args.receiver.trim() ? args.receiver.trim() : null;
  const key = typeof args.key === 'string' && args.key.trim() ? args.key.trim() : null;
  if (!receiver && !key && !args.connected) return null;
  if (!receiver || !key) {
    const missing = !receiver && !key ? '--receiver and --key are missing.' : !receiver ? '--receiver is missing.' : '--key is missing.';
    throw new Error(`${CONNECTED_HELP} ${missing}`);
  }
  return { receiver, key, name: args.playerName ?? undefined };
}

/** Read the .ronu's manifest.json without trusting the rest of the zip. */
function manifestText(ronuBytes) {
  try {
    const members = fflate.unzipSync(ronuBytes, { filter: (f) => f.name === 'manifest.json' });
    return members['manifest.json'] ? new TextDecoder().decode(members['manifest.json']) : null;
  } catch {
    return null;
  }
}

/** Build the zip bytes for one .ronu. Exported for the round-trip test. */
export function packageRonu(ronuPath, { title = null, identifier = null, xsd = true, connected = null } = {}) {
  const ronuBytes = new Uint8Array(readFileSync(ronuPath));
  if (ronuBytes.length < 4 || ronuBytes[0] !== 0x50 || ronuBytes[1] !== 0x4b) throw new Error(`${ronuPath} is not a zip (.ronu) file`);
  const useXsd = xsd && XSD_FILES.every((x) => existsSync(join(XSD_DIR, x)));
  const built = buildPackageEntries({
    ronuBytes,
    manifestJson: manifestText(ronuBytes),
    fileName: basename(ronuPath),
    title,
    identifier,
    readPlayerFile: (rel) => new Uint8Array(readFileSync(join(PLAYER_DIR, rel))),
    readXsd: useXsd ? (name) => new Uint8Array(readFileSync(join(XSD_DIR, name))) : null,
    connected,
  });
  const zipEntries = {};
  for (const [path, bytes] of Object.entries(built.entries)) {
    // The .ronu and the icons are already compressed; everything else deflates well.
    const stored = path === 'module.ronu' || path.endsWith('.png');
    zipEntries[path] = [bytes, { level: stored ? 0 : 6 }];
  }
  return { zip: fflate.zipSync(zipEntries), title: built.title, identifier: built.identifier, moduleId: built.moduleId, files: Object.keys(built.entries), xsd: useXsd, connected: built.connected };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    usage(2);
  }
  if (args.help || !args.file) usage(args.help ? 0 : 2);
  let connected;
  try {
    connected = connectedOptions(args);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const outFile = args.out ?? `${basename(args.file).replace(/\.(ronu|zip)$/i, '')}-scorm.zip`;
  let result;
  try {
    result = packageRonu(args.file, { title: args.title, identifier: args.identifier, connected });
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  mkdirSync(dirname(resolve(outFile)), { recursive: true });
  writeFileSync(outFile, result.zip);
  console.log(`wrote ${outFile} (${result.zip.length} bytes)`);
  console.log(`  title: ${result.title}`);
  console.log(`  identifier: ${result.identifier}`);
  console.log(`  files: ${result.files.length} (imsmanifest.xml, launch.html, module.ronu, player/*${result.connected ? ', ronu-package.json' : ''}${result.xsd ? ', the four SCORM 1.2 XSDs' : ''})`);
  if (result.connected) console.log(`  connected package: receiver ${connected.receiver}, module ${result.moduleId}, key ending ${connected.key.slice(-4)} (self-contained without --receiver and --key)`);
  else console.log('  self-contained package (add --receiver <origin> --key <customer API key> for a connected one)');
}
