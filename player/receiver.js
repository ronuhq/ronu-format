// The record receiver bridge (docs/record-receiver.md): discovery, the
// connect message, the stored session and its refresh, and the two calls a
// connected player makes: send a session record, run a conversation turn.
//
// No DOM. `fetch` and the clock are injected so the whole thing runs in Node
// tests against a fake receiver; the browser wiring (popup, dialog, storage)
// is in receiver-ui.js.

export const DEFAULT_RECEIVER_ORIGIN = 'https://ronunest.com';
export const PLAYER_NAME = 'ronu reference player';
export const CONNECT_MESSAGE_TYPE = 'ronu-receiver-connect';
export const CONTRACT_VERSION = 0;
export const REFRESH_WINDOW_SECONDS = 60; // section 2: refresh when expiry is this close
export const SLIM_ANSWER_BYTES = 512; // section 3, 413: an answer larger than this is dropped on the retry

/** An error with a `code` the UI can branch on, plus the HTTP status and body when there was one. */
export class ReceiverError extends Error {
  constructor(message, { code = 'error', status = null, body = null, cause = null } = {}) {
    super(message);
    this.name = 'ReceiverError';
    this.code = code;
    this.status = status;
    this.body = body;
    if (cause) this.cause = cause;
  }
}

// ---- origins and discovery (section 1) --------------------------------------

/**
 * A receiver origin as typed by a person: scheme optional, path dropped.
 * Section 6: plain http is only acceptable on localhost during development.
 */
export function normalizeOrigin(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new ReceiverError('Enter the receiver address, for example https://ronunest.com', { code: 'bad-origin' });
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new ReceiverError(`"${input}" is not a web address.`, { code: 'bad-origin' });
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol === 'http:' && !local) throw new ReceiverError('A receiver must use https (plain http is only allowed on localhost).', { code: 'bad-origin' });
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ReceiverError('A receiver address must start with https://', { code: 'bad-origin' });
  return url.origin;
}

/**
 * Find the connect page: `<origin>/.well-known/ronu-receiver.json`, else
 * `<origin>/player-connect`. `connect` may be relative to the origin.
 */
export async function discoverConnectUrl(origin, { fetch = globalThis.fetch } = {}) {
  const fallback = { connect: `${origin}/player-connect`, name: null, discovered: false };
  try {
    const res = await fetch(`${origin}/.well-known/ronu-receiver.json`, { cache: 'no-cache' });
    if (!res.ok) return fallback;
    const doc = await res.json();
    if (!doc || typeof doc !== 'object' || typeof doc.connect !== 'string' || !doc.connect) return fallback;
    return { connect: new URL(doc.connect, `${origin}/`).href, name: typeof doc.name === 'string' ? doc.name : null, discovered: true };
  } catch {
    return fallback;
  }
}

/** The popup URL: the connect page with the player's origin and name (section 2, step 1). */
export function buildConnectUrl(connect, { playerOrigin, name = PLAYER_NAME }) {
  const url = new URL(connect);
  url.searchParams.set('origin', playerOrigin);
  url.searchParams.set('name', name);
  return url.href;
}

// ---- the connect message (section 2) ----------------------------------------

function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * Validate the shape of a connect message (or a decoded connection code) and
 * return the `{receiver, session, user}` block the player stores. Throws a
 * ReceiverError naming the first thing wrong.
 */
export function parseConnection(data) {
  if (!data || typeof data !== 'object') throw new ReceiverError('The connection is not an object.', { code: 'invalid-connection' });
  if (data.type !== undefined && data.type !== CONNECT_MESSAGE_TYPE) throw new ReceiverError(`Unexpected message type "${data.type}".`, { code: 'invalid-connection' });
  if (data.version !== undefined && data.version !== CONTRACT_VERSION) {
    throw new ReceiverError(`This connection uses contract version ${data.version}; this player speaks version ${CONTRACT_VERSION}.`, { code: 'invalid-connection' });
  }
  const r = data.receiver;
  if (!r || typeof r !== 'object') throw new ReceiverError('The connection has no receiver block.', { code: 'invalid-connection' });
  const receiver = {};
  for (const key of ['origin', 'supabaseUrl', 'anonKey', 'records', 'conversation']) {
    const v = str(r[key]);
    if (!v) throw new ReceiverError(`The connection's receiver.${key} is missing.`, { code: 'invalid-connection' });
    receiver[key] = key === 'anonKey' ? v : v.replace(/\/+$/, '');
  }
  receiver.name = str(r.name) ?? 'Receiver';
  for (const key of ['origin', 'supabaseUrl', 'records', 'conversation']) {
    try {
      const u = new URL(receiver[key]);
      if (key === 'origin' && u.origin !== receiver.origin) throw new Error('not an origin');
    } catch {
      throw new ReceiverError(`The connection's receiver.${key} is not a valid URL.`, { code: 'invalid-connection' });
    }
  }
  const s = data.session;
  if (!s || typeof s !== 'object') throw new ReceiverError('The connection has no session.', { code: 'invalid-connection' });
  const session = { access_token: str(s.access_token), refresh_token: str(s.refresh_token), expires_at: typeof s.expires_at === 'number' && Number.isFinite(s.expires_at) ? s.expires_at : null, token_type: str(s.token_type) ?? 'bearer' };
  if (!session.access_token) throw new ReceiverError('The connection has no access token.', { code: 'invalid-connection' });
  if (!session.refresh_token) throw new ReceiverError('The connection has no refresh token.', { code: 'invalid-connection' });
  const u = data.user && typeof data.user === 'object' ? data.user : {};
  const user = { id: str(u.id) ?? '', email: str(u.email) ?? '', name: str(u.name) ?? '' };
  return { receiver, session, user };
}

/**
 * Section 2 step 4: accept a window message only from the origin the popup
 * was opened on, only while waiting, and only if it parses. Anything else is
 * null (ignored), never an exception, because any page can post to a window.
 */
export function validateConnectEvent(event, expectedOrigin, { waiting = true } = {}) {
  if (!waiting || !event || typeof event !== 'object') return null;
  if (typeof expectedOrigin !== 'string' || event.origin !== expectedOrigin) return null;
  const d = event.data;
  if (!d || typeof d !== 'object' || d.type !== CONNECT_MESSAGE_TYPE) return null;
  try {
    return parseConnection(d);
  } catch {
    return null;
  }
}

/** The no-popup fallback: base64url of the message JSON, both directions. */
export function encodeConnectionCode(message) {
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeConnectionCode(code) {
  const raw = String(code ?? '').trim().replace(/\s+/g, '');
  if (!raw) throw new ReceiverError('Paste the connection code first.', { code: 'invalid-connection' });
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  let json;
  try {
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    json = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    throw new ReceiverError('That is not a connection code.', { code: 'invalid-connection' });
  }
  return parseConnection(json);
}

// ---- the session record body (section 3) ------------------------------------

/**
 * The module id a receiver keys records by. The contract names
 * `manifest.module.id`; the platform's exporter writes the same value as
 * `manifest.module.versionId` (the platform row the file was exported from),
 * so both are read. A synthesised manifest (bare module.json) has neither.
 */
export function recordModuleId(manifest) {
  const m = manifest?.module;
  if (!m || typeof m !== 'object') return null;
  for (const key of ['id', 'versionId']) {
    const v = str(m[key]);
    if (v && !v.startsWith('local:')) return v;
  }
  return null;
}

/** Section 3: `{moduleId, responses, path, variableState}` from the engine's final state. */
export function buildRecordBody(engine, manifest) {
  const moduleId = recordModuleId(manifest);
  if (!moduleId) {
    throw new ReceiverError('This file has no platform module id in its manifest (a bare module.json, or a hand-made zip), so a receiver cannot tell which module it is. It cannot be recorded.', { code: 'no-module-id' });
  }
  const responses = {};
  for (const [nodeId, r] of Object.entries(engine.responses ?? {})) {
    if (!r || typeof r !== 'object') continue;
    const entry = { answer: r.response === undefined ? null : r.response };
    if (typeof r.score === 'number' && Number.isFinite(r.score)) entry.score = Math.max(0, Math.min(100, Math.round(r.score)));
    responses[nodeId] = entry;
  }
  const path = (engine.events ?? []).filter((e) => e && e.type === 'entered' && typeof e.nodeId === 'string').map((e) => ({ nodeId: e.nodeId, enteredAt: new Date(e.at).toISOString() }));
  const variableState = {};
  for (const v of engine.variables()) if (typeof v.id === 'string') variableState[v.id] = v.value === undefined ? null : v.value;
  return { moduleId, responses, path, variableState };
}

/** 413: keep every score, drop answers whose JSON is over the limit. Returns the same object when nothing was dropped. */
export function slimRecordBody(body, { maxAnswerBytes = SLIM_ANSWER_BYTES } = {}) {
  let dropped = 0;
  const responses = {};
  for (const [id, r] of Object.entries(body.responses ?? {})) {
    let size = 0;
    try {
      size = JSON.stringify(r.answer ?? null).length;
    } catch {
      size = Infinity;
    }
    if (size > maxAnswerBytes) {
      dropped += 1;
      responses[id] = typeof r.score === 'number' ? { score: r.score } : {};
    } else responses[id] = r;
  }
  return dropped ? { ...body, responses } : body;
}

/** The 200 body, normalised: `{passed, score, certificate}` plus whatever else came back. */
export function normalizeRecordResult(body) {
  const b = body && typeof body === 'object' ? body : {};
  const cert = b.certificate && typeof b.certificate === 'object' && str(b.certificate.verification_code) ? { verification_code: b.certificate.verification_code, issued_at: b.certificate.issued_at ?? null, expires_at: b.certificate.expires_at ?? null } : null;
  return { passed: b.passed === true ? true : b.passed === false ? false : null, score: typeof b.score === 'number' ? b.score : null, certificate: cert, attemptNumber: typeof b.attemptNumber === 'number' ? b.attemptNumber : null, raw: b };
}

export function certificateUrl(connection, verificationCode) {
  return `${connection.receiver.origin}/certificates/${encodeURIComponent(verificationCode)}`;
}

function serverMessage(body) {
  return body && typeof body === 'object' && str(body.error) ? body.error : null;
}

/** What to tell the learner for a non-200 from the records endpoint (section 3 table). */
export function describeRecordFailure(status, body) {
  const said = serverMessage(body);
  switch (status) {
    case 403:
      return { code: 'forbidden', retryable: false, message: said ?? 'You do not have access to this module on the receiver, so this play-through cannot be recorded.' };
    case 404:
      return { code: 'not-found', retryable: false, message: said ?? 'The receiver does not have this module. A file from another platform, or a module deleted since it was exported, cannot be recorded.' };
    case 413:
      return { code: 'too-large', retryable: false, message: 'The record is too large for the receiver, even with the answers trimmed.' };
    case 400:
      return { code: 'rejected', retryable: false, message: said ?? 'The receiver rejected the record.' };
    default:
      return { code: status >= 500 ? 'server' : 'rejected', retryable: status >= 500, message: said ?? `The receiver answered ${status}. Your record is kept; try again.` };
  }
}

// ---- the client (sections 2 to 4) -------------------------------------------

async function readJson(res) {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export class ReceiverClient {
  /**
   * @param {object} connection  `{receiver, session, user}` from parseConnection
   * @param {object} [o]  { fetch, now, onSession(connection), onDisconnect(message) }
   */
  constructor(connection, o = {}) {
    this.connection = connection;
    this.fetch = o.fetch ?? globalThis.fetch;
    this.now = o.now ?? (() => Date.now());
    this.onSession = o.onSession ?? (() => {});
    this.onDisconnect = o.onDisconnect ?? (() => {});
    this.dead = false;
    this.refreshing = null;
  }

  get receiver() {
    return this.connection.receiver;
  }

  get session() {
    return this.connection.session;
  }

  /** Section 2: within 60 seconds of expiry (an unknown expiry is left to the 401 path). */
  sessionExpiresSoon() {
    const at = this.session.expires_at;
    if (typeof at !== 'number') return false;
    return at * 1000 - this.now() < REFRESH_WINDOW_SECONDS * 1000;
  }

  disconnected(message) {
    if (this.dead) return;
    this.dead = true;
    this.onDisconnect(message);
  }

  assertAlive() {
    if (this.dead) throw new ReceiverError('Not connected to the receiver. Connect again.', { code: 'disconnected' });
  }

  /** POST <supabaseUrl>/auth/v1/token?grant_type=refresh_token. A failure disconnects. */
  refreshSession() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async doRefresh() {
    this.assertAlive();
    const { supabaseUrl, anonKey } = this.receiver;
    let res;
    let body = null;
    try {
      res = await this.fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: this.session.refresh_token }),
      });
      body = await readJson(res);
    } catch (e) {
      throw new ReceiverError('Could not reach the receiver to renew your session. Check your connection and try again.', { code: 'network', cause: e });
    }
    const token = str(body?.access_token);
    if (!res.ok || !token) {
      const why = str(body?.error_description) ?? str(body?.msg) ?? serverMessage(body) ?? `HTTP ${res.status}`;
      this.disconnected(`Your ${this.receiver.name} session could not be renewed (${why}). You have been disconnected; connect again to continue.`);
      throw new ReceiverError('Your session has expired and could not be renewed. Connect again.', { code: 'disconnected', status: res.status, body });
    }
    const expiresAt = typeof body.expires_at === 'number' ? body.expires_at : typeof body.expires_in === 'number' ? Math.floor(this.now() / 1000) + body.expires_in : null;
    const session = { access_token: token, refresh_token: str(body.refresh_token) ?? this.session.refresh_token, expires_at: expiresAt, token_type: str(body.token_type) ?? 'bearer' };
    this.connection = { ...this.connection, session };
    await this.onSession(this.connection);
    return session;
  }

  async ensureFreshSession() {
    this.assertAlive();
    if (this.sessionExpiresSoon()) await this.refreshSession();
  }

  /** One authenticated POST (section 3 headers). A 401 is refreshed and retried once; a second 401 disconnects. */
  async call(url, body, { retryOn401 = true } = {}) {
    await this.ensureFreshSession();
    let res;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.session.access_token}`, apikey: this.receiver.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new ReceiverError(`Could not reach ${this.receiver.name}. Check your connection and try again.`, { code: 'network', cause: e });
    }
    const json = await readJson(res);
    if (res.status === 401) {
      if (retryOn401) {
        await this.refreshSession();
        return this.call(url, body, { retryOn401: false });
      }
      this.disconnected(`${this.receiver.name} no longer accepts this session. You have been disconnected; connect again to continue.`);
      throw new ReceiverError('Your session was rejected. Connect again.', { code: 'disconnected', status: 401, body: json });
    }
    return { ok: res.ok, status: res.status, body: json };
  }

  /**
   * Section 3. Resolves with `{result, slimmed}` on 200; throws a ReceiverError
   * whose `code` is one of forbidden, not-found, too-large, rejected, server,
   * network, disconnected.
   */
  async sendRecord(body) {
    let r = await this.call(this.receiver.records, body);
    let slimmed = false;
    if (r.status === 413) {
      const slim = slimRecordBody(body);
      if (slim !== body) {
        slimmed = true;
        r = await this.call(this.receiver.records, slim);
      }
    }
    if (r.ok) return { result: normalizeRecordResult(r.body), slimmed, body: r.body };
    const d = describeRecordFailure(r.status, r.body);
    throw new ReceiverError(d.message, { code: d.code, status: r.status, body: r.body });
  }

  conversationBody(params, finalize) {
    const body = { version: CONTRACT_VERSION, persona: String(params.persona ?? ''), objective: String(params.objective ?? ''), moodStates: Array.isArray(params.moodStates) ? params.moodStates : [], messages: params.messages.map((m) => ({ role: m.role === 'learner' ? 'learner' : 'character', content: String(m.content ?? '') })), finalize };
    if (str(params.moduleId)) body.moduleId = params.moduleId;
    if (finalize && Array.isArray(params.criteria) && params.criteria.length) body.criteria = params.criteria;
    return body;
  }

  conversationFailure(r) {
    const said = serverMessage(r.body);
    if (r.status === 429) return new ReceiverError(said ?? 'The conversation limit has been reached for today.', { code: 'limit', status: r.status, body: r.body });
    return new ReceiverError(said ?? `The character could not reply (the receiver answered ${r.status}).`, { code: r.status >= 500 ? 'server' : 'rejected', status: r.status, body: r.body });
  }

  /** Section 4, `finalize: false`. Resolves `{reply, mood, degraded, usage}`. */
  async conversationTurn(params) {
    const r = await this.call(this.receiver.conversation, this.conversationBody(params, false));
    if (!r.ok) throw this.conversationFailure(r);
    const b = r.body ?? {};
    if (serverMessage(b)) throw new ReceiverError(b.error, { code: 'rejected', status: r.status, body: b });
    if (typeof b.reply !== 'string') throw new ReceiverError('The character did not reply. Try again.', { code: 'rejected', status: r.status, body: b });
    return { reply: b.reply, mood: str(b.mood), degraded: b.degraded === true, usage: b.usage && typeof b.usage === 'object' ? b.usage : null };
  }

  /** Section 4, `finalize: true`. Resolves `{assessment, usage}`; the assessment may arrive wrapped or bare. */
  async conversationFinalize(params) {
    const r = await this.call(this.receiver.conversation, this.conversationBody(params, true));
    if (!r.ok) throw this.conversationFailure(r);
    const b = r.body ?? {};
    if (serverMessage(b)) throw new ReceiverError(b.error, { code: 'rejected', status: r.status, body: b });
    const a = b.assessment && typeof b.assessment === 'object' ? b.assessment : b;
    if (typeof a.score !== 'number' || !Number.isFinite(a.score)) throw new ReceiverError('The assessment did not come back. Try ending the conversation again.', { code: 'rejected', status: r.status, body: b });
    const assessment = { score: Math.max(0, Math.min(100, Math.round(a.score))), summary: str(a.summary) ?? '' };
    if (Array.isArray(a.criteria)) assessment.criteria = a.criteria.filter((c) => c && typeof c === 'object' && str(c.id)).map((c) => ({ id: c.id, score: typeof c.score === 'number' ? c.score : null, comment: str(c.comment) ?? null }));
    for (const key of ['model', 'promptVersion', 'gradedAt']) if (str(a[key])) assessment[key] = a[key];
    return { assessment, usage: b.usage && typeof b.usage === 'object' ? b.usage : null };
  }

  /** Section 2 disconnect: tell the receiver, then the caller forgets the session. Never throws. */
  async logout() {
    const { supabaseUrl, anonKey } = this.receiver;
    try {
      await this.fetch(`${supabaseUrl}/auth/v1/logout`, { method: 'POST', headers: { Authorization: `Bearer ${this.session.access_token}`, apikey: anonKey } });
    } catch {
      /* the session is forgotten locally regardless */
    }
    this.dead = true;
  }
}

/**
 * The once-only guard of section 3: a session record is sent at most once.
 * Holds the receiver's answer after success so the UI can show it again, and
 * refuses a second send. `reset()` when a new session starts.
 */
export function createRecordSender(client) {
  let sent = null;
  let inFlight = null;
  return {
    get client() {
      return client;
    },
    get sent() {
      return sent;
    },
    get sending() {
      return inFlight !== null;
    },
    async send(body) {
      if (sent) throw new ReceiverError('This session has already been sent.', { code: 'already-sent' });
      if (inFlight) return inFlight;
      inFlight = client.sendRecord(body).then((r) => {
        sent = { at: client.now(), ...r.result, slimmed: r.slimmed, receiverOrigin: client.receiver.origin, receiverName: client.receiver.name };
        return sent;
      }).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    reset() {
      sent = null;
    },
  };
}
