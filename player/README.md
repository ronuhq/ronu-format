# ronu player

The reference player for `.ronu` files. Open a file, play it, offline, no account. It exists to prove the format can be implemented from the spec alone, and to give anyone a reason to produce `.ronu` files: today only the RonuNest platform plays them; with this, any browser does.

It is plain web technology: ES modules, one HTML file, CSS, no framework, no build step, one vendored dependency ([fflate](https://github.com/101arrowz/fflate), MIT, for unzip). It runs from any static file server and installs as a PWA that works offline after the first load. The layout is mobile-first and landscape-friendly; cheap Android phones are the target.

It was written from `spec/ronu-spec.md`, the JSON Schema, the samples and the Rust validator, not from the platform's player code. The places where the spec was not enough are in [SPEC-GAPS.md](SPEC-GAPS.md). That file is part of the deliverable.

## Run it

From the repository root:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/player/
```

Any static server works (GitHub Pages included). It does not run from `file://` because ES modules and the service worker need an origin.

Ways to open a file:

- drop a `.ronu` on the page, or tap the box to pick one (`.ronu`, `.zip`, or a bare `module.json`);
- "Try the showcase" loads `samples/showcase/showcase.ronu`, a real room with its panorama and character sprites bundled (4.8 MB); "Try a sample" loads `samples/hello-ronu/hello.ronu`, the smallest complete file; the "Under the sink" link below the URL box loads that sample's `module.json` (a scene, a choice and an AI conversation);
- paste any address into the URL box, or open `index.html?ronu=<url>` (the server must allow CORS). A bare `module.json` fetched by URL picks up a `manifest.json` sitting beside it, so the sample folders keep their platform module id (see "Sending a play-through");
- the last file you opened is kept in IndexedDB, so reopening the installed app offline still has it.

The header has **Session record** (a panel listing every event so far, with "Download JSON"), the RonuNest control (**Connect**, or your email and **Disconnect**), and **Close**. The end screen shows pass or fail, the score, every variable, node scores and the path taken, then the actions: Send to RonuNest (when connected), Play again, Open another file, Download session record. A scene card has a **Fullscreen** button (the Fullscreen API on the whole card, so the in-room cards come along); on a phone the panorama fills the height of the screen.

Other samples can be zipped into real `.ronu` files with the helper:

```bash
node player/tools/zip-sample.mjs samples/fantasy-series-quiz /tmp/quiz.ronu
```

## Conformance

Level 1, "minimal player" (spec section 6): the skeleton, every `stable` catalogue type, evolution rules 5.1 to 5.4, fully offline from the zip. Two `provisional` types are implemented as well because the spec text was enough; they are tagged "provisional" in the UI.

| Type | Status |
|---|---|
| `message` | Full. Content is sanitised (see Security). `files[]` are listed as attachments. |
| `video` | Full for bundled or direct media files (`<video>`, subtitles as a track, `autoplay`). YouTube and Vimeo page URLs (legacy, online only) are embedded. `onVideoComplete` and `onVideoTimestamp` triggers fire from the native element. |
| `choice` | Full. Per-choice actions and routing. Legacy `router` accepted. |
| `textInput` | Full. |
| `multipleChoice` | Full. Single or multiple, per-choice actions, `advanceOnAnswer`. |
| `ranking` | Full. Up and down buttons rather than drag, for touch and assistive tech. |
| `matching` | Full. Select per left item; graded feedback and a 0 to 100 node score when `matchingGraded` is not false; per-item actions fire on correct matches. |
| `rating` | Full. Numbers, stars or emoji; writes `ratingVariableId`. |
| `condition` | Full. Canonical `criteria` object and the legacy stringified `choices`; legacy `decisionPath` accepted. All the operators real files use (SPEC-GAPS G1 to G5). |
| `note` | Skipped, as the spec requires. |
| `scene` `photo2d` | Full. Markers at fractional x/y; hidden hotspots found by tapping within `discoveryRadius`. |
| `scene` `photo360` | Full for the stable surface. The 360 view is a simple drag-to-pan render of the equirectangular image, not a perspective projection; the yaw/pitch mapping is documented at the top of `pano.js` and in SPEC-GAPS G10. Hidden and visible hotspots, `required`, `allRequired`, `ordered`, `missActions`, `reveal` (text, image, video), routing. A hotspot `conversation` runs live while connected to RonuNest (see "Conversations through RonuNest"), otherwise it shows a fallback card. |
| `scene` hotspot `interaction` (spec 7.2) | Full. A hotspot may carry `{type, config}` for any of the eight nestable types (`message`, `multipleChoice`, `textInput`, `matching`, `ranking`, `rating`, `procedure`, `dragToTarget`). It opens as a beat between the conversation and the reveal, is answered in the room by the same engine calls and the same renderer as the top-level type, and never routes; the answer and any score are recorded against the hotspot (`<sceneId>/<hotspotId>`) and its choices', steps' and items' `actions[]` fire as usual. A `required` hotspot with an interaction only counts once answered; Close puts the learner back in the room and the later beats wait. Placeholders apply inside nested content. A non-nestable type is ignored, as if the hotspot had none. |
| `scene` `abortWhen` (spec 7.2) | Full. `{variableId, operator (default is_true), value, targetNodeId}`, the completion rule's comparison. Re-evaluated after every action fired inside the scene (hotspot `variableActions`, `missActions`, nested interaction actions, a procedure step's `earlyActions`, timer actions); when it holds the learner leaves at once for `targetNodeId`, even mid-procedure. Not evaluated on entry. |
| `procedure` | Implemented (provisional). Steps shown in a shuffled order; out-of-turn steps are reported as they happen with `ifEarly` and `earlyActions`; `procedureHaltOnCritical`. |
| `dragToTarget` | Implemented (provisional), as tap-to-place. Distractors count as right only when left unused. |
| `conversation` | Live while connected to RonuNest (provisional): the character's `firstMessage`, one call per learner line through the receiver's `ai-conversation` function, "End conversation" for the assessment, the score written to `scoreVariableId`. Not connected, or the call fails: the fallback card, and Continue. |
| `code`, `scene` `splat` and `embed3d` | Fallback card (rule 5.2): title, "this step needs a newer player", Continue. `code.source` is never executed. |
| Unknown and `x-` namespaced types | Same fallback. |

Runtime semantics implemented: start node, connections, variables with typed initial values and computed formulas, every `VariableAction` operator, `onNodeEnter`, `onNodeExit` and `onTimerElapsed` triggers, node and module `TimerConfig` (countdown and count-up, `onExpire` none, advance, route, end, `recordVariableId`, warning window), `{placeholder}` substitution, completion rules in `variable`, `reachedNode` and `nodeScore` modes, and the end screen.

Not implemented: Back navigation (`allowPrevious`), timer sounds, learner-scoped variables across files (the spec says an offline player treats them as module-scoped), the code sandbox, and AI conversation without a receiver. Offline there is no AI grader, so a `conversation`'s `scoreVariableId` keeps its initial value; a file whose gate depends on it (the `margarets-room` sample) loops the learner back to the room (SPEC-GAPS G47). Connected to RonuNest, the conversation runs for real and the score is written (see below).

## Connecting to RonuNest

A `.ronu` file plays with no account, and by default nothing leaves the device. Optionally the player connects to a **record receiver** (RonuNest is the first; [`docs/record-receiver.md`](../docs/record-receiver.md) is the contract, and any platform can implement it). Connected, two things change: a finished play-through can be sent to the receiver, where it is graded, certified and counted like an online one, and `conversation` steps run through the receiver's AI instead of showing the fallback card.

The flow, as the contract has it:

1. **Connect** (top bar, opener, or the "Connect to RonuNest" prompt on a conversation or the end screen) opens a dialog. The receiver defaults to `https://ronunest.com`; "change" takes another origin (plain `http` only on localhost, for a dev server or the mock below). The player fetches `<origin>/.well-known/ronu-receiver.json` to find the connect page and falls back to `<origin>/player-connect`.
2. "Open RonuNest sign-in" opens the connect page in a popup, with the player's origin and name in the query string. You sign in on the receiver's own pages (the player never sees a password or embeds a sign-in form) and approve the player. The page posts one `ronu-receiver-connect` message to the player; the player accepts it only from the origin it opened and only while it is waiting for one.
3. **No popup?** If the browser blocked the window, open the connect page in a tab from the link in the dialog; if the page has no opener it shows a **connection code** (base64url of the same message) with a copy button. Paste it into the dialog and "Use code".
4. The receiver block, the session and the user are stored in IndexedDB, so the connection survives a reload and the installed app keeps it. The top bar shows your email. Before every call, a session within 60 seconds of expiry is refreshed through the receiver's GoTrue endpoint; a 401 from an endpoint refreshes and retries once. If the refresh fails you are disconnected and told so on the next screen.
5. **Disconnect** (top bar, or the opener) calls the receiver's logout and forgets everything stored. Do it on a shared device: a stored session is as sensitive as being signed in.

## Sending a play-through

On the end screen, **Send to RonuNest** posts the session record to the receiver's `records` endpoint: `{moduleId, responses, path, variableState}` exactly as section 3 of the contract, built from the engine's final state (`receiver.js`, `buildRecordBody`). Only answered nodes are sent, with a 0 to 100 `score` where the player computed one (matching, procedure, dragToTarget, an assessed conversation); the receiver recomputes pass or fail from its own copy of the rule, so the player's verdict is never sent.

- `moduleId` is the platform id from `manifest.json` (`module.id`, or the exporter's `module.versionId`). A file without one, a bare `module.json` with no manifest beside it or a hand-made zip, cannot be recorded and the end screen says so.
- **Once per session.** After a 200 the end screen shows the receiver's verdict and score, links the certificate (`<origin>/certificates/<code>`) when one was issued, and the button goes away. The "sent" flag is stored with the last-opened file, so reopening the same file shows "already sent on ..." with the certificate link; Play again starts a new session, which may be sent as a new attempt.
- 401 refreshes and retries once, then disconnects; 403 (no access) and 404 (the receiver does not have this module) are final and say so; 413 drops long answers, keeps every score, and retries once; a network or 5xx failure keeps the record so you can try again.

The **Session record** panel and its "Download JSON" are the local, xAPI-shaped record described below; it is a superset of what is sent and stays on the device.

## Conversations through RonuNest

While connected, a `conversation` node (and a scene hotspot's `conversation` block) is a live chat with the character: the `firstMessage` opens, each line you send goes to the receiver's `conversation` endpoint with the persona, objective, mood states and the full transcript (section 4 of the contract), and the reply comes back with the character's mood. The creator who owns the module pays for the turns, as online. `maxTurns` (default 6) bounds the exchange; reaching it ends the conversation by itself.

- **End conversation** (tap twice, so one mis-tap does not end it) sends `finalize: true`; the assessment `{score, summary, criteria}` is shown, the score is written to the node's `scoreVariableId` with a `set` action, and the node's answer (transcript plus assessment) is recorded with that score, so the record sent above carries it and a `condition` on the score routes correctly.
- **Degraded** (`degraded: true`, the creator's allowance is spent): the character can only wrap up; the input closes and "End and assess" is the one thing left.
- An error (`{error}` with 4xx or 5xx, or no network) is shown; the line you typed comes back into the box to send again, and "Skip the character and continue" takes the fallback card and lets you move on. Not connected at all, the node shows the fallback card with a Connect prompt, as a minimal player would.
- Inside a scene the same card opens over the room; Close puts you back in the room with the conversation waiting, and the hotspot's later beats (reveal, route) run once it is ended.

## The mock receiver

`player/tools/mock-receiver.mjs` is a fake RonuNest for trying all of the above without an account. Node only, no dependencies:

```bash
node player/tools/mock-receiver.mjs --static 8000 --receiver 8787
```

It serves the repository on the static port (the player at `/player/`, the samples at `/samples/`, and `/mock/<sample>.ronu` zips any sample folder with its manifest on the fly) and the receiver on the other: `/.well-known/ronu-receiver.json` (with the receiver's coordinates, contract section 7), a `/player-connect` page that consents at once and posts the connect message to its opener (or shows a connection code), `/functions/v1/record-completion` (validates the headers and the body shape, answers `passed: true, score: 100` and a `MOCK-1234` certificate), `/functions/v1/ai-conversation` (canned replies; a line containing "degrade" gets the degraded reply, one containing "fail" a 500; finalize returns an assessment, with per-criterion scores when a rubric was sent), `/functions/v1/creator-api` (the `player_session` action a connected package's key buys: the key `mock-key` gets a session for the learner the request names, any other key is 401 `unauthorized`; `MOCK_SESSION_ERROR=tier_required|invalid_learner|module_not_found|module_not_owned` forces that code), and the GoTrue refresh and logout paths. Sessions expire after 45 seconds so the refresh path runs. `MOCK_RECORD_STATUS=403|404|413|500` makes the record call fail that way; `MOCK_MAX_BODY` sets the 413 ceiling. `--static 0` runs the receiver alone (the SCORM harness below does that for you).

Then open `http://localhost:8000/player/`, Connect, "change" the receiver to `http://localhost:8787`, and go. The mock only connects players on `http://localhost` or `http://127.0.0.1`.

## Packaging for an LMS (SCORM 1.2)

An enterprise LMS (Moodle, Cornerstone, Workday Learning, SCORM Cloud) imports a SCORM package like any other course. This player can be that package: the runtime, a `.ronu` file and a SCORM 1.2 adapter in one zip, running entirely inside the LMS and reporting through the standard runtime API. It comes in two flavours, self-contained and connected (next section); `docs/lms-integration.md` explains where they sit next to xAPI.

```bash
node player/tools/scorm-package.mjs samples/hello-ronu/hello.ronu
# wrote hello-scorm.zip; --title "..." --out <zip> --identifier <id> override the defaults
node player/tools/scorm-package.mjs samples/hello-ronu/hello.ronu --receiver https://ronunest.com --key <customer API key>
# the same zip as a connected package: adds ronu-package.json and the machine launch
```

The title and the manifest identifier come from the file's `manifest.json` (`module.title`, and `ronu-<familyId>`); the fallbacks are the file name and a slug of it. The zip holds:

- `imsmanifest.xml` at the root: SCORM 1.2, one organization, one item, one resource of `adlcp:scormtype="sco"` whose `href` is `launch.html`, listing every packaged file.
- `launch.html`: the page the LMS opens. It holds the player in a full-window iframe (`player/index.html?ronu=../module.ronu&scorm=1`) rather than redirecting to it, so the LMS's SCO frame keeps the URL the manifest named (some LMSs key their tracking frame, exit handling and reloads on that href). The player is one same-origin frame down and reaches the LMS API by walking `parent`.
- `player/`: the runtime (`index.html`, the modules, `app.css`, `vendor/fflate.js`, the icons). Not the tests, the tools, the service worker or the PWA manifest: a package lives inside the LMS and must not cache itself or register anything.
- `module.ronu`: the file, byte for byte.
- The four SCORM 1.2 schema files (`ims_xml.xsd`, `imscp_rootv1p1p2.xsd`, `imsmd_rootv1p2p1.xsd`, `adlcp_rootv1p2.xsd`), which the specification wants at the package root. They are vendored under `player/tools/scorm-xsd/` (see the note there on where they came from), so packaging is offline; most LMSs never read them, strict validators do.

In SCORM mode (`?scorm=1` with an API found through the frame chain, `scorm.js`) the player skips the service worker and the "last file" store, hides the opener screen and the Close and "Open another file" buttons, and calls the LMS: `LMSInitialize` on load (reading the learner's name for the top bar and marking a fresh attempt `incomplete`), `cmi.core.lesson_location` and a compact `cmi.suspend_data` on every node entry (committed at most every three seconds), and at the end `cmi.core.score.raw` (0 to 100), `cmi.core.lesson_status` (`passed` or `failed` when the module has a pass rule, else `completed`), `cmi.core.session_time`, `LMSCommit`, `LMSFinish`. The end screen says what was recorded. Leaving early sends the time so far with `cmi.core.exit` `suspend`. The score is the average node score when the module scored any node; a module whose only score is a variable rule reports 100 when passed and 0 when not, because a raw variable is not a percentage. Play again after the outcome went to the LMS is a practice run: the LMS keeps the first outcome of the launch, and a new attempt is a new launch from the LMS. If `?scorm=1` is set but no API is found (the package opened outside an LMS), the player runs as usual and the end screen says "No LMS found; results are not being reported". "Send to RonuNest" stays available inside an LMS when the learner is connected, so a connected learner can do both.

Resuming from `cmi.suspend_data` is not implemented: the engine has no state restore, so a relaunch starts the module from its first node. The data is written so an LMS shows where the learner was, and so a later player can pick it up.

To prove a package without an LMS, the fake one:

```bash
node player/tools/scorm-harness.mjs hello-scorm.zip --port 8791
```

It serves the package (a zip, or an unzipped directory) and a page with a logging SCORM 1.2 `window.API` over a small cmi data model (student `Dami Okafor`, status `not attempted`, the read-only, write-only and format rules of the standard), the package's `launch.html` in an iframe, a live table of the cmi values and a log of every call. Play through and watch `lesson_status`, `score.raw` and `session_time` land, then `LMSCommit` and `LMSFinish`.

To test on a real LMS for nothing: SCORM Cloud's free Trial plan takes three courses. Upload the zip as a course, launch it as a registration, then read the registration's report; it shows the same fields and flags any manifest problem on import. CI builds the hello package on every push and checks its manifest, launcher, player and file.

The limits, plainly: AI conversation characters need a connection to RonuNest (a connected package makes one by itself; in a self-contained one the learner connects from inside the package; on an air-gapped LMS the node shows its fallback card with the character's opening line); 3D worlds and `code` nodes show the fallback card; video is bundled, not streamed, so package size grows with media; updates mean re-importing the zip.

## Connected packages

A self-contained package knows nothing about RonuNest until a learner signs in through the popup. Inside an LMS that is the wrong shape: the LMS already knows who the learner is, they have no RonuNest account, and a course window should not open sign-in windows. A **connected package** fixes that with a credential issued to the customer rather than to the learner (contract section 7, `docs/record-receiver.md`): the zip carries `ronu-package.json`, and at launch the player exchanges the key in it, plus the learner the LMS names, for a session. No popup, no account, nothing to type.

| | Self-contained package | Connected package |
|---|---|---|
| Build | `scorm-package.mjs <file.ronu>` | `scorm-package.mjs <file.ronu> --receiver <origin> --key <key>` |
| In the zip | player, `module.ronu`, `launch.html`, `imsmanifest.xml`, the XSDs | the same, plus `ronu-package.json` (`{version, receiver, key, moduleId, name}`); the launcher adds `&machine=1` |
| At launch | plays at once | reads the file, fetches the receiver's discovery, posts `player_session` with `cmi.core.student_id` and `cmi.core.student_name`; the top bar says "connected as <name>" |
| AI characters | fallback card, unless the learner connects through the popup | live, for the LMS's learner |
| At the end | the LMS report | the LMS report first, then the play-through is sent to RonuNest by itself, once; the end screen shows both, with the certificate link |
| If RonuNest cannot be reached, or the key is refused | not applicable | one line on the end screen ("Could not connect to RonuNest: <why>. Playing offline."), the fallback cards, and the LMS report as usual; the popup connect is still offered |
| Stored on the learner's browser | the popup connection, if they made one | nothing: the session lives in memory for that launch and there is no Disconnect |
| Play again | practice for the LMS | practice for both; a second send is a manual button and makes a new attempt |

**Getting a key.** In RonuNest, open your nest's settings, then Portal API keys, and create a key for the customer. Issue **one key per LMS customer** and build that customer's packages with it: the key can only mint sessions for that customer's learners on modules your account owns, and revoking it in the same place cuts off every package that carries it, and nothing else. A revoked or mistyped key fails with `unauthorized` and the package plays offline, so a bad key never breaks a course. The key is visible to whoever can open the zip; that is the intended boundary, so never put one customer's key in another customer's package. `--connected` on its own, or `--receiver` without `--key` (or the reverse), is an error that says what is missing.

**The learner on RonuNest.** The receiver keeps a tenant learner per (customer, `cmi.core.student_id`); the same student id on a later launch is the same learner, so attempts and certificates accumulate. An LMS that leaves the id blank (or a package opened outside an LMS with `?machine=1`) gets `anonymous-<random>`, a new learner every launch; the player logs that it did so.

**Trying it locally.** The harness can run the mock receiver beside the fake LMS, so the whole path (LMS launch, key exchange, live character, automatic send, score in the LMS) runs on your machine with no real server:

```bash
node player/tools/zip-sample.mjs samples/under-the-sink /tmp/sink.ronu
node player/tools/scorm-package.mjs /tmp/sink.ronu --receiver http://localhost:8787 --key mock-key --out /tmp/sink-connected.zip
node player/tools/scorm-harness.mjs /tmp/sink-connected.zip --port 8791 --receiver-mock 8787
# then open http://127.0.0.1:8791/
```

Build the same package with `--key wrong-key` to see the offline path. The mock only accepts `mock-key`; plain `http` receivers are accepted on localhost only.

The code: `machine-session.js` (no DOM; the package file, discovery, the request and the response mapping, the end-of-run order) and the wiring in `app.js`. The session it produces is the same `{receiver, session, user}` the popup delivers, so `receiver.js`, `conversation.js` and the end screen do not know which way they were connected.

## Architecture

```
player/
  index.html            the one page
  app.js                bootstrap: open files, IndexedDB, ?ronu=, service worker
  ui.js                 rendering (all DOM lives here and in pano.js / sanitize.js)
  pano.js               the photo360 drag-to-pan viewer
  sanitize.js           allowlist HTML sanitiser for message.content
  engine.js             the runtime: graph, variables, actions, timers, scoring, events. No DOM.
  conditions.js         condition and completion operators. No DOM.
  formula.js            computed-variable formulas (mirrors rust/src/formula.rs). No DOM.
  bundle.js             unzip, manifest and module, media resolver. No DOM.
  session.js            the event log as xAPI-like statements. No DOM.
  receiver.js           the record-receiver bridge: discovery, the connect message, session refresh,
                        the record body and the once-only send, the conversation calls. No DOM; fetch injected.
  conversation.js       the conversation state machine over a receiver client. No DOM.
  receiver-ui.js        the connect dialog (popup, paste-a-code), the stored connection, the top-bar control
  machine-session.js    the connected package's key exchange (contract section 7): ronu-package.json, discovery
                        with coordinates, the player_session call, the LMS-first end-of-run order. No DOM; fetch injected.
  store.js              IndexedDB key-value store: the last file, the receiver connection
  scorm.js              the SCORM 1.2 adapter: API discovery, the session, progress and outcome. No DOM.
  sw.js                 service worker: app-shell cache
  manifest.webmanifest  PWA manifest
  vendor/fflate.js      unzip (MIT, licence alongside)
  test/                 Node test suite
  tools/                icon generator, sample zipper, the mock receiver, the SCORM packager and fake LMS
```

The engine is a plain state machine. The UI calls `start()`, then `choose()`, `answerText()`, `activateHotspot()`, `tapScene()`, `performStep()`, `dismissBeat()`, `continue()` and so on, and reads `view()` to know what to draw. While a scene's interaction beat is open, `view().interaction` is the nested sub-node in the same shape as a node view, and the answer calls (`answerMultiple()`, `performStep()`, `placeItem()` and the rest) apply to it instead of the scene; the UI draws it with the same `render_<type>` function it uses for the top-level node. A clock is injected, so timers are tested with a fake one. Everything without a DOM runs unchanged in Node, which is what the tests use.

## Session record

The player keeps an in-memory log (node entered, answer given, variable changed, hotspot found, timer expired, completed); **Session record** in the header lists it as it grows, and "Download JSON" there (or on the end screen) downloads it. Statements are xAPI-like: ADL verbs, the activity IRI from `manifest.json` (`activityIri`, or derived from `module.familyId` per `docs/xapi-activity-ids.md`), node sub-activities at `{iri}/nodes/{id}`, and a placeholder actor `{"account": {"name": "local"}}`. Simulation detail (branches taken, hotspots, timer expiries, variable changes) rides in extensions under `https://ronunest.com/xapi/ext/`. Nothing is sent anywhere unless you connect to a receiver and press Send, and then it is the smaller contract shape that goes, not these statements.

## Security

A `.ronu` file is untrusted by design; it may have arrived over WhatsApp.

- `message.content` is rebuilt element by element through an allowlist (`p br strong em u ul ol li h1-h4 a img blockquote code pre`). Links must be `http(s)` and open in a new tab with `rel="noopener"`. Images must resolve to a bundled asset (a `blob:` URL) or `http(s)`. Scripts, styles, iframes, event handlers and every other attribute are dropped. Nothing is ever assigned through `innerHTML`.
- `code` nodes are never executed. The source is not even displayed.
- Media is served from `blob:` URLs created from the zip; nothing in the file can name a filesystem path.
- The only iframes the player creates are for YouTube and Vimeo video URLs, on their own embed hosts.
- The receiver connection is a real session for the learner (the contract's section 6 explains why, and the scoped player token that will replace it). The player takes it only from a `message` event whose origin is the connect page it opened, or from a code the learner pasted; it is stored in IndexedDB, sent only to the receiver's own endpoints with the public anon key, and cleared by Disconnect. Nothing in a `.ronu` file can name a receiver or trigger a send.

## Tests

Node 20 or newer, no install:

```bash
node --test player/test/*.test.mjs
```

The suite walks every sample under `samples/*/module.json` from its start node with scripted answers (first choice, authored order, items on their targets; nested interactions answered in the room; a conversation's `scoreVariableId` set to full marks to stand in for the AI grader) and asserts on the variables and end state; tests each condition operator and every `VariableAction` operator; covers the unknown-node fallback, namespaced extensions and the legacy forms; timers with a fake clock; scene discovery and sequencing; nested interactions and `abortWhen` (`test/interaction.test.mjs`, including a focused walk of `margarets-room`); `procedure` and `dragToTarget`; the session record; opens `samples/hello-ronu/hello.ronu` (a real zip) and a fixture zip through the same unzip and resolve path the UI uses; the receiver bridge against a scripted fetch (`test/receiver.test.mjs`: the section 3 body from a real run, 413 trimming, refresh before a call and on a 401, the connect-message origin rule, connection codes, discovery, the once-only send); the conversation loop against a fake client (`test/conversation.test.mjs`: turns, moods, degraded, finalize writing the score variable, a hotspot character in a scene); the machine launch against a scripted fetch (`test/machine-session.test.mjs`: the package file, discovery with and without coordinates, the request built from SCORM values, every error code, the anonymous fallback, the timeout, and that the automatic send happens once and after the LMS report); and the SCORM packager (`test/scorm-package.test.mjs`: the manifest, both flavours of launcher, a connected build with `ronu-package.json` listed in the manifest). CI runs it in the `player` job of `.github/workflows/ci.yml`.

The DOM side (sanitiser, panorama, rendering, the connect dialog, the live conversation against the mock receiver, and a connected package inside the fake LMS) is checked in a browser; see the verification notes in the commit history.

## Licence

Apache-2.0, like the rest of the repository. `vendor/fflate.js` is MIT (`vendor/LICENSE-fflate`).
