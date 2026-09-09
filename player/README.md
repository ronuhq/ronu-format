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
- "Try a sample" loads `samples/hello-ronu/hello.ronu`, the real zip with a bundled image; "Try Under the sink" loads that sample's `module.json`;
- `index.html?ronu=<url>` loads a remote file (the server must allow CORS);
- the last file you opened is kept in IndexedDB, so reopening the installed app offline still has it.

The header has **Record** (download the session record as JSON) and **Close**. The end screen shows pass or fail, the score, every variable, node scores and the path taken.

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
| `scene` `photo360` | Full for the stable surface. The 360 view is a simple drag-to-pan render of the equirectangular image, not a perspective projection; the yaw/pitch mapping is documented at the top of `pano.js` and in SPEC-GAPS G10. Hidden and visible hotspots, `required`, `allRequired`, `ordered`, `missActions`, `reveal` (text, image, video), routing. Hotspot `conversation` shows a fallback card (needs an AI backend). |
| `scene` hotspot `interaction` (spec 7.2) | Full. A hotspot may carry `{type, config}` for any of the eight nestable types (`message`, `multipleChoice`, `textInput`, `matching`, `ranking`, `rating`, `procedure`, `dragToTarget`). It opens as a beat between the conversation and the reveal, is answered in the room by the same engine calls and the same renderer as the top-level type, and never routes; the answer and any score are recorded against the hotspot (`<sceneId>/<hotspotId>`) and its choices', steps' and items' `actions[]` fire as usual. A `required` hotspot with an interaction only counts once answered; Close puts the learner back in the room and the later beats wait. Placeholders apply inside nested content. A non-nestable type is ignored, as if the hotspot had none. |
| `scene` `abortWhen` (spec 7.2) | Full. `{variableId, operator (default is_true), value, targetNodeId}`, the completion rule's comparison. Re-evaluated after every action fired inside the scene (hotspot `variableActions`, `missActions`, nested interaction actions, a procedure step's `earlyActions`, timer actions); when it holds the learner leaves at once for `targetNodeId`, even mid-procedure. Not evaluated on entry. |
| `procedure` | Implemented (provisional). Steps shown in a shuffled order; out-of-turn steps are reported as they happen with `ifEarly` and `earlyActions`; `procedureHaltOnCritical`. |
| `dragToTarget` | Implemented (provisional), as tap-to-place. Distractors count as right only when left unused. |
| `conversation`, `code`, `scene` `splat` and `embed3d` | Fallback card (rule 5.2): title, "this step needs a newer player", Continue. `code.source` is never executed. |
| Unknown and `x-` namespaced types | Same fallback. |

Runtime semantics implemented: start node, connections, variables with typed initial values and computed formulas, every `VariableAction` operator, `onNodeEnter`, `onNodeExit` and `onTimerElapsed` triggers, node and module `TimerConfig` (countdown and count-up, `onExpire` none, advance, route, end, `recordVariableId`, warning window), `{placeholder}` substitution, completion rules in `variable`, `reachedNode` and `nodeScore` modes, and the end screen.

Not implemented: Back navigation (`allowPrevious`), timer sounds, learner-scoped variables across files (the spec says an offline player treats them as module-scoped), the code sandbox, AI conversation. Because there is no AI grader, a `conversation`'s `scoreVariableId` keeps its initial value; a file whose gate depends on it (the `margarets-room` sample) loops the learner back to the room in this player (SPEC-GAPS G47).

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
  sw.js                 service worker: app-shell cache
  manifest.webmanifest  PWA manifest
  vendor/fflate.js      unzip (MIT, licence alongside)
  test/                 Node test suite
  tools/                icon generator, sample zipper
```

The engine is a plain state machine. The UI calls `start()`, then `choose()`, `answerText()`, `activateHotspot()`, `tapScene()`, `performStep()`, `dismissBeat()`, `continue()` and so on, and reads `view()` to know what to draw. While a scene's interaction beat is open, `view().interaction` is the nested sub-node in the same shape as a node view, and the answer calls (`answerMultiple()`, `performStep()`, `placeItem()` and the rest) apply to it instead of the scene; the UI draws it with the same `render_<type>` function it uses for the top-level node. A clock is injected, so timers are tested with a fake one. Everything without a DOM runs unchanged in Node, which is what the tests use.

## Session record

The player keeps an in-memory log (node entered, answer given, variable changed, hotspot found, timer expired, completed) and **Record** downloads it as JSON. Statements are xAPI-like: ADL verbs, the activity IRI from `manifest.json` (`activityIri`, or derived from `module.familyId` per `docs/xapi-activity-ids.md`), node sub-activities at `{iri}/nodes/{id}`, and a placeholder actor `{"account": {"name": "local"}}`. Simulation detail (branches taken, hotspots, timer expiries, variable changes) rides in extensions under `https://ronunest.com/xapi/ext/`. Nothing is sent anywhere.

## Security

A `.ronu` file is untrusted by design; it may have arrived over WhatsApp.

- `message.content` is rebuilt element by element through an allowlist (`p br strong em u ul ol li h1-h4 a img blockquote code pre`). Links must be `http(s)` and open in a new tab with `rel="noopener"`. Images must resolve to a bundled asset (a `blob:` URL) or `http(s)`. Scripts, styles, iframes, event handlers and every other attribute are dropped. Nothing is ever assigned through `innerHTML`.
- `code` nodes are never executed. The source is not even displayed.
- Media is served from `blob:` URLs created from the zip; nothing in the file can name a filesystem path.
- The only iframes the player creates are for YouTube and Vimeo video URLs, on their own embed hosts.

## Tests

Node 20 or newer, no install:

```bash
node --test player/test/*.test.mjs
```

The suite walks every sample under `samples/*/module.json` from its start node with scripted answers (first choice, authored order, items on their targets; nested interactions answered in the room; a conversation's `scoreVariableId` set to full marks to stand in for the AI grader) and asserts on the variables and end state; tests each condition operator and every `VariableAction` operator; covers the unknown-node fallback, namespaced extensions and the legacy forms; timers with a fake clock; scene discovery and sequencing; nested interactions and `abortWhen` (`test/interaction.test.mjs`, including a focused walk of `margarets-room`); `procedure` and `dragToTarget`; the session record; and opens `samples/hello-ronu/hello.ronu` (a real zip) and a fixture zip through the same unzip and resolve path the UI uses. CI runs it in the `player` job of `.github/workflows/ci.yml`.

The DOM side (sanitiser, panorama, rendering) is checked in a browser; see the verification notes in the commit history.

## Licence

Apache-2.0, like the rest of the repository. `vendor/fflate.js` is MIT (`vendor/LICENSE-fflate`).
