// The browser side of the record receiver bridge (docs/record-receiver.md
// sections 1, 2 and 6): the stored connection, the connect dialog with its
// popup and the paste-a-code fallback, and disconnect. The transport itself
// is receiver.js (no DOM); the engine never sees any of this.

import { h } from './ui.js';
import { dbGet, dbPut } from './store.js';
import {
  DEFAULT_RECEIVER_ORIGIN, PLAYER_NAME, ReceiverClient, ReceiverError, discoverConnectUrl, buildConnectUrl,
  validateConnectEvent, decodeConnectionCode, normalizeOrigin,
} from './receiver.js';

const STORE_KEY = 'receiver';

/**
 * Holds the one connection the player has, persists it, and hands out a
 * ReceiverClient. `subscribe()` to redraw when it changes. `notice` carries
 * the reason for the last disconnect so a screen can show it once.
 */
export class ReceiverController {
  constructor({ playerOrigin = location.origin, fetch = globalThis.fetch.bind(globalThis) } = {}) {
    this.playerOrigin = playerOrigin;
    this.fetch = fetch;
    this.connection = null;
    this.client = null;
    this.origin = DEFAULT_RECEIVER_ORIGIN;
    this.notice = null;
    this.listeners = new Set();
    // A machine launch (docs/record-receiver.md section 7): the session came
    // from a package key for the LMS's learner. It is never written to
    // IndexedDB (the next launch may be another learner on the same browser)
    // and there is no Disconnect; closing the course drops it.
    this.machine = null; // { name } while a machine session is in use
    this.ephemeral = false;
  }

  get connected() {
    return Boolean(this.connection && this.client && !this.client.dead);
  }

  get name() {
    return this.connection?.receiver?.name ?? 'RonuNest';
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) {
      try {
        fn(this);
      } catch (e) {
        console.error(e);
      }
    }
  }

  async load() {
    const saved = await dbGet(STORE_KEY);
    if (saved?.origin) this.origin = saved.origin;
    if (saved?.connection) this.adopt(saved.connection, { persist: false });
  }

  persist() {
    if (this.ephemeral) return Promise.resolve();
    return dbPut(STORE_KEY, { origin: this.origin, connection: this.connection });
  }

  /** Take a validated connection into use (from the popup, a pasted code, or storage). */
  adopt(connection, { persist = true } = {}) {
    this.connection = connection;
    this.notice = null;
    this.client = new ReceiverClient(connection, {
      fetch: this.fetch,
      onSession: (c) => {
        this.connection = c;
        return this.persist();
      },
      onDisconnect: (message) => this.forget(message),
    });
    if (persist) this.persist();
    this.emit();
  }

  /**
   * Section 7: take the session a package key minted for the LMS's learner.
   * Nothing is persisted, so a stored popup connection on this browser is
   * left as it was, and a later `forget` (a failed refresh) writes nothing.
   */
  adoptMachine(connection, { name = null } = {}) {
    this.ephemeral = true;
    this.machine = { name: name ?? connection?.user?.name ?? connection?.user?.email ?? 'a learner' };
    this.adopt(connection, { persist: false });
  }

  /** Drop the stored session (after a failed refresh, or a disconnect). */
  async forget(message = null) {
    this.connection = null;
    this.client = null;
    this.notice = message;
    this.machine = null;
    await this.persist();
    this.emit();
  }

  /** Section 2 disconnect: logout, then forget. Never throws. */
  async disconnect() {
    const client = this.client;
    await this.forget(null);
    if (client) await client.logout();
  }

  takeNotice() {
    const n = this.notice;
    this.notice = null;
    return n;
  }

  /**
   * Open the connect dialog. Resolves true once connected, false if the
   * learner cancelled. Safe to call while a dialog is already open.
   */
  connect() {
    if (this.dialogPromise) return this.dialogPromise;
    this.dialogPromise = openConnectDialog(this).finally(() => {
      this.dialogPromise = null;
    });
    return this.dialogPromise;
  }
}

/**
 * The dialog: choose the receiver (default ronunest.com, a "change" affordance
 * for a dev server), open the connect page in a popup, wait for the one
 * message from that origin, or take a pasted connection code.
 */
function openConnectDialog(ctl) {
  return new Promise((resolve) => {
    let waiting = false;
    let expectedOrigin = null;
    let popup = null;
    let pollTimer = null;
    let connectUrl = null;

    const dialog = h('dialog.connect-dialog', { 'aria-labelledby': 'connect-title' });
    const originLabel = h('span.origin-label', ctl.origin);
    const originInput = h('input.input', { type: 'url', value: ctl.origin, placeholder: 'https://ronunest.com', 'aria-label': 'Receiver address', spellcheck: false, autocapitalize: 'off' });
    const originForm = h('form.origin-form', { hidden: true, onsubmit: (e) => { e.preventDefault(); applyOrigin(); } }, originInput, h('button.btn.btn-small', { type: 'submit' }, 'Use'));
    const status = h('p.connect-status', { role: 'status', 'aria-live': 'polite' });
    const openBtn = h('button.btn.btn-primary', { onclick: () => startPopup() }, `Open ${receiverName()} sign-in`);
    // Opens synchronously (a blank tab), then navigates once the connect page is known: popup blockers allow the first, not a late open.
    const tabLink = h('a', { href: '#', onclick: (e) => { e.preventDefault(); const tab = window.open('about:blank', '_blank'); resolveConnectUrl().then((url) => { if (tab) tab.location.href = url; else setStatus(`Open this address in a new tab: ${url}`); }).catch((err) => setStatus(err.message, 'error')); } }, 'open the connect page in a tab');
    const codeInput = h('textarea.input', { rows: 3, placeholder: 'Paste the connection code here', 'aria-label': 'Connection code', spellcheck: false });
    const useCode = h('button.btn', { onclick: () => useConnectionCode() }, 'Use code');

    function receiverName() {
      return ctl.origin === DEFAULT_RECEIVER_ORIGIN ? 'RonuNest' : 'the receiver';
    }

    function setStatus(text, kind = '') {
      status.textContent = text ?? '';
      status.className = `connect-status${kind ? ` is-${kind}` : ''}`;
    }

    function applyOrigin() {
      try {
        ctl.origin = normalizeOrigin(originInput.value);
      } catch (e) {
        setStatus(e.message, 'error');
        return;
      }
      originInput.value = ctl.origin;
      originLabel.textContent = ctl.origin;
      originForm.hidden = true;
      openBtn.textContent = `Open ${receiverName()} sign-in`;
      connectUrl = null;
      setStatus('');
      ctl.persist();
    }

    async function resolveConnectUrl() {
      if (connectUrl) return connectUrl;
      const found = await discoverConnectUrl(ctl.origin, { fetch: ctl.fetch });
      connectUrl = buildConnectUrl(found.connect, { playerOrigin: ctl.playerOrigin, name: PLAYER_NAME });
      // Section 2 step 4: the message must come from the origin the popup was opened on.
      expectedOrigin = new URL(connectUrl).origin;
      return connectUrl;
    }

    function onMessage(event) {
      const connection = validateConnectEvent(event, expectedOrigin, { waiting });
      if (!connection) return;
      finish(connection);
    }

    async function startPopup() {
      if (!originForm.hidden) applyOrigin();
      setStatus(`Finding ${receiverName()}'s connect page.`);
      // The window must open inside the click, or a popup blocker eats it; the URL follows.
      popup = window.open('about:blank', 'ronu-receiver-connect', 'popup=yes,width=520,height=720');
      let url;
      try {
        url = await resolveConnectUrl();
      } catch (e) {
        popup?.close();
        setStatus(e.message ?? String(e), 'error');
        return;
      }
      waiting = true;
      if (!popup) {
        setStatus('The sign-in window was blocked. Open the connect page in a tab (link below) and paste the code it shows.', 'error');
        return;
      }
      try {
        popup.location.href = url;
      } catch {
        /* cross-origin navigation of a fresh popup is allowed; a failure here means it was closed */
      }
      setStatus(`Sign in to ${receiverName()} in the window that opened, then approve this player. Waiting.`);
      clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        if (popup && popup.closed) {
          clearInterval(pollTimer);
          if (waiting) setStatus('The sign-in window closed before connecting. Open it again, or paste a connection code.', 'error');
          waiting = false;
        }
      }, 500);
    }

    function useConnectionCode() {
      let connection;
      try {
        connection = decodeConnectionCode(codeInput.value);
      } catch (e) {
        setStatus(e instanceof ReceiverError ? e.message : 'That is not a connection code.', 'error');
        return;
      }
      finish(connection);
    }

    function finish(connection) {
      waiting = false;
      cleanup();
      ctl.adopt(connection);
      dialog.close();
      resolve(true);
    }

    function cancel() {
      waiting = false;
      cleanup();
      dialog.close();
      resolve(false);
    }

    function cleanup() {
      window.removeEventListener('message', onMessage);
      clearInterval(pollTimer);
      try {
        if (popup && !popup.closed) popup.close();
      } catch {
        /* already gone */
      }
      popup = null;
    }

    window.addEventListener('message', onMessage);

    dialog.append(
      h('h2', { id: 'connect-title' }, 'Connect to RonuNest'),
      h('p', 'Sign in to the receiver in its own window and approve this player. The player never sees your password; it receives a session it uses to send your play-throughs and to talk to AI characters as you.'),
      h('p.small.muted', 'Receiver: ', originLabel, ' ', h('button.btn-link', { onclick: () => { originForm.hidden = !originForm.hidden; if (!originForm.hidden) originInput.focus(); } }, 'change')),
      originForm,
      h('div.actions.actions-wrap', openBtn, h('button.btn', { onclick: cancel }, 'Cancel')),
      status,
      h('details.connect-code',
        h('summary', 'No popup? Paste a connection code'),
        h('p.small.muted', 'If the sign-in window is blocked, ', tabLink, ', copy the code it shows after you approve, and paste it here.'),
        codeInput,
        h('div.actions', useCode),
      ),
      h('p.small.muted', 'Disconnect from the top bar when you are done on a shared device.'),
    );
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      cancel();
    });
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
  });
}

/**
 * The "RonuNest" control: connect, or the user's email with Disconnect. Used
 * in the top bar (`compact`: the email only) and on the opener (`bare`: the
 * Disconnect button only, the opener names the user itself).
 */
export function receiverControl(ctl, { compact = false, bare = false, onChange } = {}) {
  const changed = () => onChange?.();
  if (ctl.connected && ctl.machine) {
    // A machine session: the package connected the LMS's learner; there is nothing to sign out of.
    const who = ctl.machine.name;
    return h('span.receiver-control.is-connected.is-machine',
      h('span.receiver-user', { title: `${ctl.name}: connected through this package as ${who}` }, compact ? `connected as ${who}` : `${ctl.name}: connected as ${who}`),
    );
  }
  if (ctl.connected) {
    const email = ctl.connection.user.email || ctl.connection.user.name || 'connected';
    return h('span.receiver-control.is-connected',
      bare ? null : h('span.receiver-user', { title: `${ctl.name}: ${email}` }, compact ? email : `${ctl.name}: ${email}`),
      h('button.btn.btn-ghost.btn-small', { onclick: async () => { await ctl.disconnect(); changed(); }, title: `Disconnect from ${ctl.name}` }, 'Disconnect'),
    );
  }
  return h('span.receiver-control',
    h('button.btn.btn-ghost.btn-small', { onclick: async () => { await ctl.connect(); changed(); }, title: 'Sign in to RonuNest so play-throughs can be recorded there' }, compact ? 'Connect' : 'Connect to RonuNest'),
  );
}
