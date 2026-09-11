// Machine launch (docs/record-receiver.md section 7): a "connected package"
// carries a customer key in `ronu-package.json`. At launch the player reads
// that file, fetches the receiver's discovery document for its coordinates,
// and exchanges the key plus the LMS's learner for a session. No popup, no
// account: the LMS's learner becomes a tenant learner on the receiver and
// the session drops into the same store the popup handshake fills.
//
// No DOM. `fetch` and the random source are injected, so the whole exchange
// runs in Node against a scripted fetch; app.js does the wiring.

import { CONTRACT_VERSION, ReceiverError, normalizeOrigin, parseConnection } from './receiver.js';

export const PACKAGE_FILE = 'ronu-package.json';
export const SESSION_ACTION = 'player_session';
export const DEFAULT_PACKAGE_PLAYER_NAME = 'ronu player';
export const EXCHANGE_TIMEOUT_MS = 15_000;
export const ANONYMOUS_PREFIX = 'anonymous-';

/** The receiver's error codes for the session exchange, with what the player tells the learner. */
export const SESSION_ERROR_MESSAGES = {
  unauthorized: 'the package\'s key was not accepted (it may have been revoked)',
  tier_required: 'the account that issued the package\'s key needs a plan that includes connected packages',
  invalid_learner: 'the LMS gave no usable learner identity',
  module_not_found: 'the receiver does not have this module',
  module_not_owned: 'this module does not belong to the account that issued the package\'s key',
};

function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function absolute(value, origin) {
  try {
    return new URL(value, `${origin}/`).href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

// ---- the package file -------------------------------------------------------

/**
 * `ronu-package.json`: `{version, receiver, key, moduleId, name}`. Takes the
 * parsed object or the JSON text. Throws a ReceiverError (`bad-package`) naming
 * the first thing wrong; a file without a key is not a connected package and
 * comes back with `key: null` so the caller can fall back to self-contained.
 */
export function parsePackageConfig(input) {
  let doc = input;
  if (typeof input === 'string') {
    try {
      doc = JSON.parse(input);
    } catch {
      throw new ReceiverError(`${PACKAGE_FILE} is not JSON.`, { code: 'bad-package' });
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new ReceiverError(`${PACKAGE_FILE} is not an object.`, { code: 'bad-package' });
  if (doc.version !== undefined && doc.version !== CONTRACT_VERSION) {
    throw new ReceiverError(`${PACKAGE_FILE} uses version ${doc.version}; this player speaks version ${CONTRACT_VERSION}.`, { code: 'bad-package' });
  }
  const key = str(doc.key);
  let receiver = null;
  if (key) {
    if (!str(doc.receiver)) throw new ReceiverError(`${PACKAGE_FILE} has a key but no receiver.`, { code: 'bad-package' });
    try {
      receiver = normalizeOrigin(doc.receiver);
    } catch (e) {
      throw new ReceiverError(`${PACKAGE_FILE} names an invalid receiver: ${e.message}`, { code: 'bad-package' });
    }
  } else if (str(doc.receiver)) {
    try {
      receiver = normalizeOrigin(doc.receiver);
    } catch {
      receiver = null;
    }
  }
  return { version: CONTRACT_VERSION, receiver, key, moduleId: str(doc.moduleId), name: str(doc.name) ?? DEFAULT_PACKAGE_PLAYER_NAME };
}

/**
 * Read `<packageRoot>/ronu-package.json`. `packageRoot` is the directory the
 * launcher put the file in (the package root; the module sits beside it).
 * Resolves null when there is no such file (a self-contained package), the
 * parsed config otherwise; throws on a file that is there but broken.
 */
export async function readPackageConfig(packageRoot, { fetch = globalThis.fetch } = {}) {
  let url;
  try {
    const root = String(packageRoot ?? '');
    url = new URL(PACKAGE_FILE, root.endsWith('/') ? root : `${root}/`).href;
  } catch {
    throw new ReceiverError(`The package root "${packageRoot}" is not an absolute URL.`, { code: 'bad-package' });
  }
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch (e) {
    throw new ReceiverError(`Could not read ${PACKAGE_FILE}.`, { code: 'network', cause: e });
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new ReceiverError(`Could not read ${PACKAGE_FILE} (HTTP ${res.status}).`, { code: 'bad-package', status: res.status });
  return parsePackageConfig(await res.text());
}

// ---- discovery, with coordinates (section 7) --------------------------------

/**
 * The discovery document with the receiver's coordinates. Every URL may be
 * relative to the origin. Throws `no-machine-launch` when the coordinates a
 * machine launch needs are missing (a receiver that only does the popup).
 */
export function parseDiscovery(doc, origin) {
  if (!doc || typeof doc !== 'object') throw new ReceiverError('The receiver\'s discovery document is not an object.', { code: 'no-machine-launch' });
  const out = { origin, name: str(doc.name) ?? 'Receiver', connect: absolute(str(doc.connect) ?? '/player-connect', origin) };
  for (const key of ['supabaseUrl', 'records', 'conversation', 'session']) {
    const v = str(doc[key]) ? absolute(doc[key], origin) : null;
    if (!v) throw new ReceiverError(`The receiver at ${origin} does not support machine launch (discovery has no "${key}").`, { code: 'no-machine-launch' });
    out[key] = v;
  }
  const anonKey = str(doc.anonKey);
  if (!anonKey) throw new ReceiverError(`The receiver at ${origin} does not support machine launch (discovery has no "anonKey").`, { code: 'no-machine-launch' });
  out.anonKey = anonKey;
  return out;
}

/** GET `<origin>/.well-known/ronu-receiver.json` and parse it for a machine launch. */
export async function discoverReceiver(origin, { fetch = globalThis.fetch } = {}) {
  let res;
  let doc;
  try {
    res = await fetch(`${origin}/.well-known/ronu-receiver.json`, { cache: 'no-cache' });
  } catch (e) {
    throw new ReceiverError(`Could not reach the receiver at ${origin}.`, { code: 'network', cause: e });
  }
  if (!res.ok) throw new ReceiverError(`The receiver at ${origin} has no discovery document (HTTP ${res.status}).`, { code: 'no-machine-launch', status: res.status });
  try {
    doc = await res.json();
  } catch {
    throw new ReceiverError(`The receiver at ${origin} has a broken discovery document.`, { code: 'no-machine-launch' });
  }
  return parseDiscovery(doc, origin);
}

// ---- the learner ------------------------------------------------------------

function randomId(random) {
  if (typeof random === 'function') return String(random());
  const bytes = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The learner the package acts for: `cmi.core.student_id` and
 * `cmi.core.student_name` from the SCORM session. An LMS that gives no
 * student id (or no LMS at all) gets `anonymous-<random>`, flagged so the UI
 * can say so; such a learner is a new tenant learner on every launch.
 */
export function learnerFromScorm(scorm, { random = null } = {}) {
  const id = str(scorm?.studentId);
  const name = str(scorm?.studentName);
  if (id) return { externalId: id, name, anonymous: false };
  return { externalId: `${ANONYMOUS_PREFIX}${randomId(random)}`, name, anonymous: true };
}

// ---- the exchange -----------------------------------------------------------

/** The section 7 request: headers and the JSON body, from the package key, the learner and the module. */
export function buildSessionRequest({ key, learner, moduleId, playerName = DEFAULT_PACKAGE_PLAYER_NAME, playerOrigin }) {
  if (!str(key)) throw new ReceiverError('The package has no key.', { code: 'bad-package' });
  if (!str(learner?.externalId)) throw new ReceiverError('The learner has no id.', { code: 'invalid_learner' });
  if (!str(moduleId)) throw new ReceiverError('The package names no module id, so the receiver cannot tell which module to grant.', { code: 'bad-package' });
  const who = { externalId: learner.externalId };
  if (str(learner.name)) who.name = learner.name;
  if (str(learner.email)) who.email = learner.email;
  return {
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: { action: SESSION_ACTION, version: CONTRACT_VERSION, learner: who, moduleId, player: { name: str(playerName) ?? DEFAULT_PACKAGE_PLAYER_NAME, origin: String(playerOrigin ?? '') } },
  };
}

/**
 * The receiver's answer, mapped: a 200 with `success: true` becomes the
 * `{receiver, session, user}` connection the popup handshake would have
 * delivered (validated the same way); anything else throws a ReceiverError
 * whose `code` is the receiver's `errorCode` when it gave one.
 */
export function mapSessionResponse(status, body, discovery) {
  const b = body && typeof body === 'object' ? body : {};
  if (status === 200 && b.success === true) {
    if (b.version !== undefined && b.version !== CONTRACT_VERSION) {
      throw new ReceiverError(`The receiver answered with contract version ${b.version}; this player speaks version ${CONTRACT_VERSION}.`, { code: 'rejected', status, body: b });
    }
    const connection = parseConnection({
      receiver: { name: discovery.name, origin: discovery.origin, supabaseUrl: discovery.supabaseUrl, anonKey: discovery.anonKey, records: discovery.records, conversation: discovery.conversation },
      session: b.session,
      user: b.user,
    });
    connection.learner = { created: b.learner?.created === true };
    return connection;
  }
  const code = str(b.errorCode);
  const known = code && SESSION_ERROR_MESSAGES[code];
  if (known) throw new ReceiverError(known, { code, status, body: b });
  const said = str(b.error);
  if (status === 401 || status === 403) throw new ReceiverError(said ?? SESSION_ERROR_MESSAGES.unauthorized, { code: 'unauthorized', status, body: b });
  if (status === 404) throw new ReceiverError(said ?? SESSION_ERROR_MESSAGES.module_not_found, { code: 'module_not_found', status, body: b });
  if (status >= 500) throw new ReceiverError(said ?? `the receiver answered ${status}`, { code: 'server', status, body: b });
  throw new ReceiverError(said ?? `the receiver answered ${status} without a session`, { code: 'rejected', status, body: b });
}

async function readJson(res) {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function withTimeout(promise, ms, what) {
  if (!(ms > 0)) return promise;
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ReceiverError(`${what} took longer than ${Math.round(ms / 1000)} seconds.`, { code: 'network' })), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** POST the session request to the receiver's `session` endpoint and map the answer. */
export async function exchangeSession({ discovery, key, learner, moduleId, playerName, playerOrigin, fetch = globalThis.fetch }) {
  const req = buildSessionRequest({ key, learner, moduleId, playerName, playerOrigin });
  let res;
  try {
    res = await fetch(discovery.session, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
  } catch (e) {
    throw new ReceiverError(`could not reach ${discovery.name}`, { code: 'network', cause: e });
  }
  return mapSessionResponse(res.status, await readJson(res), discovery);
}

/**
 * The whole launch step: read the package file, discover the receiver,
 * exchange the key. Resolves `{connection, config, discovery, learner}` when
 * connected, `null` when the package is self-contained (no file, or no key).
 * Throws a ReceiverError otherwise; the caller shows it and plays offline.
 * `moduleId` is a fallback for a package file that names none (the bundled
 * manifest's id).
 */
export async function machineConnect({ packageRoot, learner, playerOrigin, moduleId = null, fetch = globalThis.fetch, timeoutMs = EXCHANGE_TIMEOUT_MS, config = undefined }) {
  const cfg = config === undefined ? await readPackageConfig(packageRoot, { fetch }) : config;
  if (!cfg || !cfg.key) return null;
  const run = (async () => {
    const discovery = await discoverReceiver(cfg.receiver, { fetch });
    const connection = await exchangeSession({ discovery, key: cfg.key, learner, moduleId: cfg.moduleId ?? moduleId, playerName: cfg.name, playerOrigin, fetch });
    return { connection, config: cfg, discovery, learner };
  })();
  return withTimeout(run, timeoutMs, 'Connecting to the receiver');
}

/** "connected as <name>": the receiver's name for the user, else the LMS's, else the id the package sent. */
export function connectedAs(connection, learner) {
  return str(connection?.user?.name) ?? str(connection?.user?.email) ?? str(learner?.name) ?? str(learner?.externalId) ?? 'a learner';
}

/** One line for the opener or the end screen when the exchange failed. */
export function offlineNotice(error, receiverName = 'RonuNest') {
  const why = error?.message ?? String(error ?? 'unknown error');
  return `Could not connect to ${receiverName}: ${why.replace(/\.$/, '')}. Playing offline.`;
}

// ---- the end of a connected run ------------------------------------------------

/**
 * What happens when the end screen first renders in a connected launch: the
 * LMS report first, always, then one automatic send. The send is deferred a
 * tick so the report and the render that triggered it complete before any
 * network call; an LMS never waits on the receiver. Once per launch: Play
 * again is a practice run for the LMS and stays a manual send for the
 * receiver.
 */
export function createEndSequence({ report = () => {}, canSend = () => false, send = async () => null } = {}) {
  let started = false;
  let result = null;
  return {
    get started() {
      return started;
    },
    get result() {
      return result;
    },
    async onEnd(view) {
      try {
        report(view);
      } catch (e) {
        console.warn('LMS report failed', e);
      }
      if (started || !canSend()) return null;
      started = true;
      await Promise.resolve();
      try {
        result = await send();
      } catch (e) {
        result = null;
      }
      return result;
    },
  };
}
