// The SCORM 1.2 runtime adapter: find the LMS's `API` object, open a session
// on it, report where the learner is, and report the outcome once.
//
// No DOM. The window walked by `findApi` and the API it finds are plain
// objects, and the clock is injected, so the whole thing runs in Node tests
// against a fake LMS. Every call into the LMS is guarded: an LMS that throws,
// returns "false" or hands back garbage never stops the player. Nothing here
// touches the network; the LMS API is an in-page JavaScript object.
//
// Element names and value formats follow the SCORM 1.2 Run-Time Environment:
// lesson_status is one of passed, completed, failed, incomplete, browsed,
// not attempted; score.raw is 0 to 100; session_time is HHHH:MM:SS.SS;
// suspend_data holds at most 4096 characters; lesson_location at most 255.

export const MAX_API_DEPTH = 500;
export const MAX_SUSPEND_DATA = 4096;
export const MAX_LESSON_LOCATION = 255;
export const DEFAULT_COMMIT_INTERVAL_MS = 3000;
export const NO_ERROR = '0';

// ---- discovery -------------------------------------------------------------

function apiOf(win) {
  try {
    const api = win.API;
    return api && typeof api.LMSInitialize === 'function' ? api : null;
  } catch {
    return null; // a cross-origin frame: reading `API` throws
  }
}

function parentOf(win) {
  try {
    const p = win.parent;
    return p && p !== win ? p : null;
  } catch {
    return null;
  }
}

/** Walk `win`, then its parents up to the top (at most MAX_API_DEPTH hops), for a SCORM 1.2 `API`. */
function scanParents(win) {
  let w = win;
  let hops = 0;
  while (w) {
    const api = apiOf(w);
    if (api) return api;
    if (hops++ >= MAX_API_DEPTH) return null;
    w = parentOf(w);
  }
  return null;
}

/**
 * The pipwerks discovery order: this window and its parents, then the
 * opener (of this window, and of the top window) and its parents. Returns
 * the API object or null. Never throws.
 */
export function findApi(win) {
  if (!win) return null;
  const own = scanParents(win);
  if (own) return own;
  const openers = [];
  try {
    if (win.opener) openers.push(win.opener);
  } catch {
    /* cross-origin opener */
  }
  try {
    const top = win.top;
    if (top && top !== win && top.opener && !openers.includes(top.opener)) openers.push(top.opener);
  } catch {
    /* cross-origin top */
  }
  for (const o of openers) {
    const api = scanParents(o);
    if (api) return api;
  }
  return null;
}

// ---- value formats ---------------------------------------------------------

/** Milliseconds as a SCORM 1.2 CMITimespan, HHHH:MM:SS.SS (hours grow past four digits if they must). */
export function formatSessionTime(ms) {
  const total = Math.max(0, Number.isFinite(ms) ? ms : 0);
  const hundredths = Math.round(total / 10);
  const h = Math.floor(hundredths / 360000);
  const m = Math.floor((hundredths % 360000) / 6000);
  const s = Math.floor((hundredths % 6000) / 100);
  const cs = hundredths % 100;
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(h, 4)}:${pad(m, 2)}:${pad(s, 2)}.${pad(cs, 2)}`;
}

function byteLength(s) {
  return new TextEncoder().encode(s).length;
}

/**
 * The resume hint the LMS keeps for us: the current node, the trail and the
 * plain variable values, as compact JSON under the 4096-byte ceiling. The
 * trail is shortened first, then the variables are dropped, then the trail.
 */
export function compactSuspendData({ nodeId = null, trail = [], values = {} } = {}, { maxBytes = MAX_SUSPEND_DATA } = {}) {
  const plain = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' || v === null) plain[k] = v;
  }
  const attempt = (t, withValues) => {
    const doc = { n: nodeId, t };
    if (withValues) doc.v = plain;
    return JSON.stringify(doc);
  };
  let t = Array.isArray(trail) ? trail.slice() : [];
  let out = attempt(t, true);
  while (byteLength(out) > maxBytes && t.length) {
    t = t.slice(Math.ceil(t.length / 2));
    out = attempt(t, true);
  }
  if (byteLength(out) > maxBytes) out = attempt(t, false);
  while (byteLength(out) > maxBytes && t.length) {
    t = t.slice(Math.ceil(t.length / 2));
    out = attempt(t, false);
  }
  return byteLength(out) > maxBytes ? JSON.stringify({ n: nodeId }) : out;
}

/**
 * What the LMS gets from an end view: `passed` (true, false, or null when the
 * module has no pass rule) and `score`, 0 to 100 or null.
 *
 * The engine's `result.score` is a percentage only when it came from scored
 * nodes (the average of node scores, or a nodeScore rule). A variable rule
 * scores by a raw number ("errors" 3, "score" 1) that is not a percentage, so
 * that case reports 100 when passed and 0 when not, and no score at all when
 * there is neither a scored node nor a pass rule.
 */
export function outcomeFor(view) {
  const r = view?.result ?? {};
  const passed = r.passed === true ? true : r.passed === false ? false : null;
  const scored = view?.nodeScores && Object.keys(view.nodeScores).length > 0;
  let score = null;
  if (scored && typeof r.score === 'number' && Number.isFinite(r.score)) score = r.score;
  else if (passed !== null) score = passed ? 100 : 0;
  if (score !== null) score = Math.max(0, Math.min(100, Math.round(score)));
  return { passed, score };
}

export function statusFor(passed) {
  return passed === true ? 'passed' : passed === false ? 'failed' : 'completed';
}

// ---- the session -----------------------------------------------------------

/**
 * A session over one SCORM 1.2 API object.
 * @param {object} api            the LMS's API (LMSInitialize and friends)
 * @param {object} [opts]
 * @param {() => number} [opts.clock]         ms clock (injectable for tests)
 * @param {number} [opts.commitInterval]      progress() commits at most this often, in ms
 * @param {(msg: string) => void} [opts.warn]  where guarded failures are reported
 */
export function createScormSession(api, { clock = () => Date.now(), commitInterval = DEFAULT_COMMIT_INTERVAL_MS, warn = () => {} } = {}) {
  const state = {
    initialized: false,
    finished: false,
    startedAt: null,
    lastCommitAt: -Infinity,
    dirty: false,
    studentName: null,
    status: null,
    suspendData: '',
    location: '',
    errors: [],
    calls: 0,
  };

  const truthy = (v) => v === true || v === 'true';

  function lastError(context) {
    let code = '';
    let text = '';
    try {
      code = String(api.LMSGetLastError?.() ?? '');
    } catch {
      code = '?';
    }
    try {
      if (code && code !== NO_ERROR && typeof api.LMSGetErrorString === 'function') text = String(api.LMSGetErrorString(code) ?? '');
    } catch {
      /* the error string is optional */
    }
    const entry = { context, code, text };
    state.errors.push(entry);
    if (state.errors.length > 50) state.errors.shift();
    warn(`SCORM ${context}: error ${code}${text ? ` (${text})` : ''}`);
    return entry;
  }

  /** Call one API function; false (and a recorded error) instead of a throw. */
  function call(name, ...args) {
    state.calls += 1;
    let result;
    try {
      const fn = api[name];
      if (typeof fn !== 'function') {
        lastError(`${name} missing`);
        return { ok: false, value: null };
      }
      result = fn.apply(api, args);
    } catch (e) {
      warn(`SCORM ${name} threw: ${e?.message ?? e}`);
      state.errors.push({ context: name, code: 'exception', text: String(e?.message ?? e) });
      return { ok: false, value: null };
    }
    return { ok: true, value: result };
  }

  function get(element) {
    const r = call('LMSGetValue', element);
    if (!r.ok) return '';
    const value = r.value == null ? '' : String(r.value);
    if (value === '') {
      // An empty string is either a real empty value or an error; the code says which.
      let code = NO_ERROR;
      try {
        code = String(api.LMSGetLastError?.() ?? NO_ERROR);
      } catch {
        code = NO_ERROR;
      }
      if (code !== NO_ERROR && code !== '') lastError(`LMSGetValue ${element}`);
    }
    return value;
  }

  function set(element, value) {
    const r = call('LMSSetValue', element, String(value));
    if (!r.ok) return false;
    if (!truthy(r.value)) {
      lastError(`LMSSetValue ${element}`);
      return false;
    }
    return true;
  }

  function commit() {
    const r = call('LMSCommit', '');
    state.lastCommitAt = clock();
    state.dirty = false;
    if (!r.ok) return false;
    if (!truthy(r.value)) {
      lastError('LMSCommit');
      return false;
    }
    return true;
  }

  function lmsFinish() {
    const r = call('LMSFinish', '');
    state.finished = true;
    if (!r.ok) return false;
    if (!truthy(r.value)) {
      lastError('LMSFinish');
      return false;
    }
    return true;
  }

  function snapshot() {
    return { ok: state.initialized, studentName: state.studentName, status: state.status, suspendData: state.suspendData, location: state.location };
  }

  const session = {
    get initialized() {
      return state.initialized;
    },
    get finished() {
      return state.finished;
    },
    get studentName() {
      return state.studentName;
    },
    get status() {
      return state.status;
    },
    get errors() {
      return state.errors.slice();
    },
    get calls() {
      return state.calls;
    },

    /** LMSInitialize, then read who and where. A fresh attempt is marked incomplete at once. */
    initialize() {
      if (state.initialized) return snapshot();
      const r = call('LMSInitialize', '');
      if (!r.ok || !truthy(r.value)) {
        if (r.ok) lastError('LMSInitialize');
        return snapshot();
      }
      state.initialized = true;
      state.startedAt = clock();
      const name = get('cmi.core.student_name');
      state.studentName = name.trim() === '' ? null : name.trim();
      state.status = get('cmi.core.lesson_status');
      state.suspendData = get('cmi.suspend_data');
      state.location = get('cmi.core.lesson_location');
      if (state.status === '' || state.status === 'not attempted') {
        if (set('cmi.core.lesson_status', 'incomplete')) state.status = 'incomplete';
        commit();
      }
      return snapshot();
    },

    /** Where the learner is now. Commits at most every `commitInterval` ms; finish() and abandon() always commit. */
    progress({ nodeId, suspendData } = {}) {
      if (!state.initialized || state.finished) return false;
      let any = false;
      if (typeof nodeId === 'string' && nodeId !== '') {
        state.location = nodeId.slice(0, MAX_LESSON_LOCATION);
        any = set('cmi.core.lesson_location', state.location) || any;
      }
      if (typeof suspendData === 'string') {
        state.suspendData = suspendData.length > MAX_SUSPEND_DATA ? suspendData.slice(0, MAX_SUSPEND_DATA) : suspendData;
        any = set('cmi.suspend_data', state.suspendData) || any;
      }
      state.dirty = state.dirty || any;
      if (state.dirty && clock() - state.lastCommitAt >= commitInterval) commit();
      return any;
    },

    /**
     * The outcome, once: score (when there is one), status, session time,
     * a normal exit, LMSCommit, LMSFinish. `result` is `{passed, score}` as
     * `outcomeFor` builds it. Returns what was recorded, or null.
     */
    finish(result = {}) {
      if (!state.initialized || state.finished) return null;
      const score = typeof result.score === 'number' && Number.isFinite(result.score) ? Math.max(0, Math.min(100, Math.round(result.score))) : null;
      if (score !== null) {
        set('cmi.core.score.min', '0');
        set('cmi.core.score.max', '100');
        set('cmi.core.score.raw', String(score));
      }
      const status = statusFor(result.passed);
      if (set('cmi.core.lesson_status', status)) state.status = status;
      set('cmi.core.session_time', formatSessionTime(clock() - state.startedAt));
      set('cmi.core.exit', '');
      commit();
      lmsFinish();
      return { status, score };
    },

    /** The learner left before the end: time so far, a suspend exit, commit, finish. */
    abandon() {
      if (!state.initialized || state.finished) return false;
      set('cmi.core.session_time', formatSessionTime(clock() - state.startedAt));
      set('cmi.core.exit', 'suspend');
      commit();
      lmsFinish();
      return true;
    },
  };
  return session;
}
