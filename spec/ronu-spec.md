# The `.ronu` File Format: Specification

**Status:** DRAFT, and **unversioned**: a living draft on trunk. Until a `v1.0` is cut, the commit hash of the [repository](https://github.com/ronuhq/ronu-format) is the effective version and every change is assumed potentially breaking; don't pin production tooling to it yet. The skeleton (§2–§6) is expected to freeze essentially as-is at `v1.0`; catalogue entries tagged `provisional` (§7) may still change shape.
**Schema baseline:** the RonuNest platform build of 9 September 2026 (platform commit `5aa3ce4`). The catalogue documents the module content schema as of that build; catalogue entries evolve, the skeleton does not.
**Companions in this repository:** [`rust/`](../rust) (the reference implementation, the executable arbiter of a valid `module.json`, in Rust) and [`samples/`](../samples) (real exported modules to test against).

---

## 0. Design in one paragraph

A `.ronu` file is a **portable, self-contained learning experience**: a branching simulation you can email, put on a USB stick, or send over WhatsApp, and play offline with no account. The format is split into two layers with different stability promises: a tiny **skeleton** (container, envelope, graph shape, evolution rules) that freezes at v1.0 and never changes meaning, and a **node catalogue** (what each node type's config means) that grows freely over time under the skeleton's evolution rules. Players tolerate what they don't understand; extensions are namespaced so anyone can add node types without permission.

## 1. The two-layer stability model (normative)

| Layer | What's in it | Promise |
|---|---|---|
| **Skeleton** (§2–§6) | Container, envelope, graph shape, variables, evolution rules, extension mechanism | Frozen at v1.0. Fields may be *added*; existing fields never change meaning, are never renamed, never removed. |
| **Catalogue** (§7) | Each node type's config profile, tagged `stable` or `provisional` | Grows freely. `stable` entries follow the skeleton promise; `provisional` entries may still change shape and are excluded from conformance claims. |
| **Semantics** (§9) | What a player does with the skeleton and the catalogue: the walk, variables, conditions, scoring, timers, scenes, media, container tolerance | Normative. A rule follows the promise of the layer it describes: a rule about a `stable` field never changes meaning; a rule about a `provisional` entry may still move. |

Once the format is versioned (at `v1.0`), the envelope's `formatVersion` will version the **skeleton**, and catalogue growth will not bump it. During the current unversioned draft phase there is no version number to rely on: the repository commit is the version.

## 2. Container

A `.ronu` file is a **ZIP archive** (like `.docx`/`.epub`) containing:

```
module.ronu (zip)
├── manifest.json     the envelope: identity, versions, integrity (REQUIRED)
├── module.json       the experience: nodes, variables, settings (REQUIRED)
└── assets/           bundled media, flat, prefixed names (OPTIONAL)
    ├── 01-intro.jpg
    └── 02-scene.mp4
```

- `manifest.json` and `module.json` are UTF-8 JSON.
- A JSON-only interchange form (just `module.json`, no zip) is legal for tooling/tests, but a conforming *exporter* always emits the zip so media travels with the file; the whole point is USB/WhatsApp shareability.

## 3. Envelope: `manifest.json`

```json
{
  "format": "ronu",
  "formatVersion": "0.9",
  "module": {
    "familyId": "efc6b26a-e7f1-4c91-ba2f-0861fff4334b",
    "versionId": "…uuid…",
    "versionNumber": 6,
    "title": "Restaurant Floor: Reading the Room",
    "description": "…",
    "language": "en",
    "thumbnail": "assets/01-cover.jpg"
  },
  "creator": { "name": "RonuNest", "url": "https://ronunest.com/creator/…" },
  "activityIri": "https://ronunest.com/xapi/modules/efc6b26a-…",
  "exportedAt": "2026-07-12T12:00:00Z",
  "exportedBy": "ronunest.com",
  "license": "…SPDX id or free text…",
  "assets": [
    { "path": "assets/01-cover.jpg", "mimeType": "image/jpeg", "bytes": 48213 }
  ]
}
```

- **`familyId` is the permanent identity** of the learning experience: it survives republishing and versioning (all versions of one module share it, while `versionId`/`versionNumber` identify the specific cut). Records keyed by `familyId` (completions, certificates, xAPI statements) stay attached to the experience across revisions.
- **`activityIri`** is the stable xAPI activity identifier, derived from the family: `{origin}/xapi/modules/{familyId}` for the module and `{activityIri}/nodes/{nodeId}` for a node within it. Any player emitting learning records about a .ronu file should use these IRIs so records from different players aggregate instead of fragmenting.
- `formatVersion` will be semver-ish once the format is versioned at `v1.0` (see §6). **The format is unversioned today**: files from this draft phase carry `"0.9"` for historical reasons, but readers MUST NOT gate compatibility on it yet; treat every trunk change as potentially breaking.
- Everything except `format`, `module.familyId`, and `module.title` is optional.

## 4. The experience: `module.json` (the skeleton part)

Top level:

```json
{ "nodes": [ … ], "variables": [ … ], "settings": { … } }
```

**Node shape**: every node is:

```json
{
  "id": "node-1",
  "type": "message",
  "title": "Welcome",
  "position": { "x": 120, "y": 340 },
  "color": "#4A90D9",
  "connection": "node-2",
  "config": { … }
}
```

- `id`: unique within the file; stable within a module version. Node sub-activity IRIs hang off it.
- `type`: a catalogue type (§7) or a namespaced extension type (§5).
- `connection`: the default next node. Branching types carry additional edges inside `config` (per-choice `connection`, hotspot `targetNodeId`, condition `criteriaSets[].targetNodeId` and `defaultTargetNodeId`, timer `onExpire.targetNodeId`, scene `abortWhen.targetNodeId`).
- `position`/`color`: canvas metadata for editors; players MUST ignore them. Kept in the format so a file re-opens in an editor exactly as authored.
- `config`: the type-specific profile (§7). Exactly one node has `config.isStart: true`.

**Variables**: the logic layer that makes this a simulation format rather than a slideshow format:

```json
{
  "id": "var-1", "name": "score", "type": "number", "initialValue": 0,
  "visible": true, "computed": false, "formula": null, "scope": "module"
}
```

`type` ∈ `number | boolean | text`. `computed` variables derive from a `formula` (arithmetic over non-computed variable names). `scope` ∈ `module` (per-session, default) | `learner` (durable across modules, a platform feature; an offline player treats it as module-scoped).

**Settings**: module-level globals: `settings.timer` (whole-module timer, `TimerConfig`) and `settings.completion` (the pass/fail rule: mode `variable` | `reachedNode` | `nodeScore`, operator, threshold, certificate flags). Completion rules are structural (they define what the experience *means*), so they belong in the file; certificate *issuance* is a platform behaviour layered on top.

**What is deliberately NOT in the file:** creator branding/theming, tenancy, pricing/access control, analytics, learner records. The format describes structure and content, not rendering or platform services.

## 5. Evolution rules (normative: this is what makes the format future-proof)

1. **Must-ignore.** A reader encountering an unrecognised JSON field MUST ignore it and continue. Writers MUST NOT change the meaning of existing fields; evolution is additive.
2. **Unknown node type.** A player encountering a node whose `type` it does not implement MUST NOT abort. It presents a neutral fallback (at minimum the node's `title` and a "this step needs a newer player" affordance) and follows the node's `connection` onward. Authors of exotic modules should keep critical routing out of nodes their audience's players may not support.
3. **Namespaced extensions.** Third-party node types use a `prefix:name` type (e.g. `"x-mubs:chemistry-lab"`). The bare (unprefixed) namespace is reserved for this spec's catalogue. Extension configs live entirely inside `config`. An extension that proves broadly useful can graduate into the catalogue with a `stable`/`provisional` tag; graduation never breaks the prefixed form.
4. **Legacy tolerance, canonical output.** Readers MUST accept the documented legacy forms (§8); writers MUST emit only canonical forms. This is how the format sheds warts without breaking old files.

## 6. Versioning & conformance

- **The format is unversioned during the current trunk-based draft phase**: the repository commit is the version and any change may break. The scheme below takes effect only when `v1.0` is cut.
- Once versioned, `formatVersion` is `MAJOR.MINOR`: MINOR bumps are always additive (rule 5.1 makes them safe); a MAJOR bump is a breaking change and is expected to be rare-to-never.
- **Minimal player** (conformance level 1): implements the skeleton + the `stable` catalogue types, rules 5.1–5.3, the player semantics of §9, and plays fully offline from the zip. May treat `code`, `conversation`, and 3-D scene kinds as unknown (rule 5.2).
- **Full player** (level 2): additionally implements the `provisional` types it declares, the code-node sandbox, and AI-backed conversation (which requires connectivity; a full player degrades to the fallback offline).
- The [reference validator](../rust) (Rust) is the executable arbiter of "valid module.json": it checks both shape and semantics (single start, no dangling edges, reachability, action/variable type agreement).
- A [JSON Schema](../schema/ronu-module.schema.json) (draft-07), **generated from the same Rust types**, covers the *structural* contract for any language; it intentionally does not (and cannot) express the cross-node semantic rules the validator enforces.

A worked example of the container, an actual `.ronu` file with a bundled image plus its unpacked contents, is in [`samples/hello-ronu/`](../samples/hello-ronu).

## 7. The node catalogue (as of the 9 Sep 2026 baseline)

Fifteen types. Tags: **stable** = shape settled, follows the skeleton promise from v1.0; **provisional** = actively evolving, expect additions/reshaping.

| Type | Tag | Config essentials |
|---|---|---|
| `message` | **stable** | `content` (rich text/HTML), `files[]` (attachments, bundled under `assets/`), `showContinueButton`, `advanceOnAnswer`. Semantics: §9.7, §9.8. |
| `video` | **stable** | `videoUrl` (bundled), `thumbnailUrl`, `subtitlesUrl`, `videoControls{autoplay, showPlayPause, showVolume, showSubtitles, allowSeeking}`. Semantics: §9.7, §9.8. |
| `choice` | **stable** | `question`, `choices[]{id, text, connection, actions[], condition}`: the core branching primitive. Semantics: §9.7. |
| `textInput` | **stable** | `question`; free-text answer recorded to the session. Semantics: §9.7. |
| `multipleChoice` | **stable** | `question`, `choices[]` (no per-choice routing), `allowMultiple`, `advanceOnAnswer`. Semantics: §9.7. |
| `ranking` | **stable** | `question`, `rankingItems[]`. Semantics: §9.7. |
| `matching` | **stable** | `matchingLeftItems[]{id, text, correctRightId, actions[]}`, `matchingRightItems[]{id, text}`, `matchingGraded`. Semantics: §9.7; grading: §9.4. |
| `rating` | **stable** | `ratingVariableId`, `ratingMin/Max`, `ratingStyle` (`stars|numbers|emoji`), low/high labels. Semantics: §9.7. |
| `condition` | **stable** (canonical form) | `criteria{criteriaSets[]{conditions[]{field, operator, value}, targetNodeId, pathLabel}, defaultTargetNodeId, defaultPathLabel}`; see §8 for the legacy stringified form. Conditions within a set are joined by connector entries of the form `{field: "operator", operator: "", value: "AND"|"OR"|"("|")"}`; a validator skips these, a player evaluates them as the boolean expression they spell out. Semantics (operators, fields, the connector grammar, routing): §9.3. |
| `procedure` | **provisional** | `question`, `procedureSteps[]{text, critical, ifEarly, earlyActions[]}`, `procedureHaltOnCritical`. Performed one step at a time, in order; a step taken out of turn is reported AS IT HAPPENS, not scored at the end. Deliberately not `ranking`: ranking sorts a list and grades on submit, which cannot express "you applied the cream before gaining consent". The answer records the order actually performed plus each misstep, so the stream carries what the learner did rather than only whether they passed. Semantics: §9.7; grading: §9.4. |
| `dragToTarget` | **provisional** | `question`, `dragTargets[]{id, label, image}`, `dragItems[]{id, label, image, targetId}`. Put the right thing in the right place. An item with **no** `targetId` belongs nowhere and is a distractor: choosing to use it at all is the mistake, which is often the thing worth assessing. Players SHOULD implement it as tap-to-place rather than literal dragging: HTML5 drag is unreliable on touch, and two ordinary buttons are far kinder on assistive tech. Semantics: §9.7; grading: §9.4. |
| `note` | **stable** | Canvas-only annotation. Players MUST skip it entirely; it is never part of the flow. Semantics: §9.1. |
| `scene` | **partially stable** | Stable: `environment{kind: photo360|photo2d, source}`, `hotspots[]{position, label, required, hidden, reveal, targetNodeId, variableActions, conversation{persona, firstMessage, objective, criteria[], maxTurns, scoreVariableId}, interaction}`, `completion` (`free|allRequired`), `hotspotSequence` (`free|ordered`), `discoveryRadius`, `missActions`, `abortWhen{variableId, operator, value, targetNodeId}` (see §7.2). **Provisional:** `kind: splat|embed3d` (renderers still landing). Semantics: §9.6. |
| `conversation` | **provisional** | `persona`, `firstMessage`, `objective`, `rubric[]{id, label, weight}`, `maxTurns`, `scoreVariableId`, `visual{background, characterName, characterKey, voice, states[]}`. Requires an AI backend; minimal players fall back per rule 5.2. The rubric names the things the grader must judge separately (a label and a relative weight, never an operator), so one opaque score becomes something a creator can read back; absent, grading is holistic. Voice/visual surface still moving. Semantics: §9.7; the connected case: [record receivers](../docs/record-receiver.md) §4. |
| `code` | **provisional** | `source` (a sandboxed `run({ctx, ui, emit})` body), `assetPack`, `assetPacks[]`, `assets3d{}`, `room{}`, `layout{version, placements[]{key, pack, kind, x, z, y, rotationY, size, animation, hookId, inspect, interaction, conversation}, intro}`, `hooks[]{id, label, trigger}`, `hookBindings{<hookId>: {interaction, conversation}}`, `effects[]{id, label, values[]}`, `effectRules[]{id, effectId, value, variableId, operator, compareValue}`, `orderingSpec`, `sourceHistory[]`. The 3-D room/asset surface is under active development (Sep 2026); see §7.1 for how the fields beside `source` are meant to be read. Executing `source` requires a sandbox; players that don't ship one use the fallback. **Security note:** a player MUST NOT execute `source` outside a sandbox: .ronu files arrive from untrusted channels by design. Semantics: §9.7. |

### 7.1 The assessment seam (code nodes)

A code node's `source` describes **what can happen**; the fields beside it describe **what it means**. That split is what lets a world written by any tool, or generated by a model nobody here has seen, still be assessed by the player rather than by the world itself.

- `hooks[]` is what the world DECLARES it can offer, recorded from the world actually running (`ui.hooks`), never parsed from `source`.
- `hookBindings` is the author's meaning, keyed by hook id and stored **outside** the code, so regenerating the world keeps the questions. A binding whose hook has gone is *orphaned*: a conforming player SHOULD surface it, and MUST NOT silently discard it.
- `effects[]` / `effectRules[]` are the same split for consequence. The world declares what it can change; the rules decide when, using the platform's one comparison triple (`variableId` / `operator` / `compareValue`), the same shape completion and abort rules use. No new operators, no nesting.
- `layout.placements[].hookId` is an optional STABLE id. Placements are otherwise addressed by index (`p0`, `p3`), which is safe inside a layout but not as a general id: reordering would repoint every binding. Readers MUST accept both, resolving `hookId` first and falling back to the index form.

A player that cannot execute `source` still reads all of this, and can present the bound questions on their own. A player that executes it but ignores the bindings is **not conforming**: it would grade the learner by whatever the world's own code decided, which is exactly what this separation prevents.

### 7.2 Answering inside a scene

A hotspot may carry an `interaction`: `{type, config}` where `type` is one of the nestable catalogue types (`message`, `multipleChoice`, `textInput`, `matching`, `ranking`, `rating`, `procedure`, `dragToTarget`) and `config` is that type's ordinary profile. The learner answers it in the room and stays there. Two rules follow from that:

- **A nested interaction never routes.** The routing types (`choice`, `condition`) are deliberately not nestable; the canvas stays the single source of truth for flow. A nested interaction records and scores (its choices' `actions[]` fire as usual); branch on the variables it sets, with a condition node after the scene.
- **A required hotspot with an interaction is only satisfied once answered.** Clicking and dismissing is not enough. A required interaction with nothing to answer (no choices, steps, items) is therefore a gate the learner can never open; the reference validator flags it.

`abortWhen` is the scene's early exit: when the variable satisfies the comparison, the learner leaves for `targetNodeId` (typically a debrief) instead of finishing the room. It uses the same `variableId` / `operator` / `value` triple as a completion rule, with `operator` defaulting to `is_true`. An in-scene question sets the variable through its actions; the scene decides to bail. That is what keeps nested interactions non-routing. The same `{interaction, conversation}` pair also hangs off a code node's `hookBindings` and `layout.placements[]`, so one editor and one renderer serve all three. The evaluation points of `abortWhen`, the beat order, and what "answered" means for each nestable type are in §9.6.

**Shared sub-schemas** (stable, used across types): `VariableAction{variableId, operator, value}` with operators `set|increment|decrement|multiply|divide|set_true|set_false|toggle`; `NodeTrigger{type: onNodeEnter|onNodeExit|onTimerElapsed|onVideoComplete|onVideoTimestamp, actions[], config}`; `TimerConfig{mode: countdown|countup, seconds, visible, label, warnAtSeconds, sound, onExpire{behavior: none|advance|route|end, targetNodeId, actions[]}, recordVariableId}`; text placeholders `{variableName}` substituted at play time. Semantics: actions and placeholders in §9.2, triggers and timers in §9.5.

The [Rust types](../rust/src/types.rs) carry the definitions for every profile above.

## 8. Canonical form vs. accepted legacy (readers accept both; writers emit canonical only)

| Concern | Canonical (what exporters write) | Legacy (what readers must also accept) |
|---|---|---|
| Condition config | `config.criteria` as a **parsed object** `{criteriaSets, defaultTargetNodeId, defaultPathLabel}` | `config.choices` as a **JSON-encoded string** of the same object |
| Node types | `choice`, `condition` | `router` → `choice`, `decisionPath` → `condition` |
| Media references | Relative bundle paths (`assets/<name>`) | Platform storage refs and absolute URLs, playable only online |
| Message attachments | `files[].path` → bundle path | `files[].data` base64 data-URLs; readers may play them; exporters convert to bundled assets |

Export rewrites every media reference in `module.json` to its bundle path and records it in the manifest; import re-uploads assets and rewrites back to platform refs.

Reader tolerances beyond this table (the legacy spellings of condition operators, media path variants, folder-prefixed zips, a missing manifest) are in §9.3, §9.8 and §9.9. The same rule applies: readers accept them, writers emit only the canonical form.

## 9. Player semantics (normative)

Sections 2 to 8 say what a file contains. This section says what a conforming player does with it, so that two independent players walk the same file the same way and record the same outcome. The key words MUST, SHOULD and MAY are used as in RFC 2119. A MUST is conformance-relevant: it decides which node the learner reaches, what is recorded, or what the verdict is at the end. A SHOULD is presentational: players are expected to compete on feel (§11), never on outcomes. The reference player in [`player/`](../player) implements every rule here and its tests walk every sample; [`player/SPEC-GAPS.md`](../player/SPEC-GAPS.md) is the audit trail of how each rule was decided.

Terms. A *pass-through node* is a `note` or a `condition`; every other node is a *displayable node*. A node's *forward edge* is its default next node (9.1). A node's *answer* is what 9.7 says its type records. *Blank* means `undefined`, `null`, the empty string, or an empty list. *Round* means round half up to the nearest integer (JavaScript `Math.round`).

### 9.1 The walk

**Start.** Exactly one node MUST carry `config.isStart: true` (the validator reports an error otherwise). A reader that nevertheless meets a file with no start flag MUST start at the first node in the `nodes` array; one that meets several MUST start at the first flagged node in array order. A file with no usable node ends at once.

**Node identity.** Node ids are compared exactly. Entries in `nodes` that are not JSON objects are ignored; a node whose `id` is not a non-empty string cannot be the target of an edge; where two nodes share an id, the first in array order is the node. A node's type is read after the legacy renames of §8: `router` MUST be treated as `choice` and `decisionPath` as `condition` before any other rule applies. Local records MAY carry the raw type name.

**Edges.** A node's forward edge is the node-level `connection`. `config.connection` MUST be read only as a fallback when the node-level field is absent or empty. Branching types carry their own edges (§4): a choice's `connection` takes precedence over the node's forward edge for that choice and falls back to it when the choice has none; a condition routes as in 9.3; a hotspot's `targetNodeId` and a scene's `abortWhen` route as in 9.6; a timer's `onExpire` routes as in 9.5. An edge whose value is absent, `null` or the empty string is no edge.

**Entering a node.** On entry the player MUST, in this order: mark the node visited and append it to the path; fire its `onNodeEnter` triggers; start its `timer` and its `onTimerElapsed` trigger (9.5); then, for a `condition`, route at once without presenting it, and for any other type present it. A `note` is never entered: it is skipped silently, none of its triggers fire, it does not appear in the path, and its forward edge is followed; a note with no forward edge ends the experience (this is what lets a note wired into a path do no harm).

**Leaving a node.** On leaving along any edge the player MUST fire the node's `onNodeExit` triggers, write the node timer's `recordVariableId` (9.5), then enter the target. An open card, beat or timer belonging to the node is discarded. One exception is the timer `end` behaviour, which ends the experience in place (9.5).

**Where the experience ends.** The experience ends when the learner leaves a node with no edge to follow: a displayable node with no forward edge and no chosen edge, a condition with no matching set, no default and no forward edge, a note with no forward edge, a scene whose hotspot route is empty and whose forward edge is empty. It also ends on a timer `end` (9.5). An edge naming a node id that does not exist (a dangling edge) MUST end the experience with an error shown to the learner, never a crash. A player MUST bound consecutive pass-through hops so that a cycle of notes and conditions with no displayable node between them ends with an error rather than hanging; the reference player's bound is 200 hops. When the experience ends the player writes the module timer's `recordVariableId`, evaluates the completion rule (9.4) and shows the end state.

**Continue.** A learner leaves a displayable node along its forward edge through a Continue affordance. Continue MUST NOT be available: on a `choice` (leaving is by choosing); while a scene card is open; on a scene with `completion: "allRequired"` until every required hotspot is satisfied (9.6); on an answer node (`textInput`, `multipleChoice`, `ranking`, `matching`, `rating`) whose `required` is `true` until it is answered; on a `procedure` or `dragToTarget` until it is completed or submitted (these two are always required); on a live `conversation` until it is ended or abandoned ([record receivers](../docs/record-receiver.md) §4). Otherwise Continue is available; a player MAY still ask for an answer before offering it on a non-required question, which is what the reference player does. When the forward edge is empty the affordance means Finish. `allowPrevious` has no defined behaviour and players MAY ignore it. `showContinueButton` is a `message` rule (9.7).

**Unsupported nodes.** A node whose type the player does not implement, including `code`, `conversation` in a minimal player, a namespaced extension, and a `scene` whose `environment.kind` is a provisional kind, is presented as the rule 5.2 fallback: it counts as visited, records no answer and no score, and Continue follows its forward edge. A scene whose `environment` or `kind` is absent or empty is not unsupported (9.6).

### 9.2 Variables

**Types and defaults.** `type` is `number`, `boolean` or `text`. When `initialValue` is absent or `null` the variable starts at `0`, `false` or `""` respectively; when present it is coerced to the declared type. Every session starts from the initial values: `scope: "learner"` MUST be treated as `module` by an offline player, and nothing carries between files or sessions.

**Coercion** applies wherever a value meets a declared type (initial values, `set`, the result of every action):

| To | Rule |
|---|---|
| `number` | A JSON number as is. A string is parsed as a decimal number with JavaScript `Number()` semantics (surrounding whitespace allowed); an empty or whitespace-only string, a string that is not a number, `null`, `undefined` and any non-finite result become `0`. `true` is `1`, `false` is `0`. |
| `boolean` | A string is `true` only when, trimmed and lower-cased, it is `true`, `yes` or `1`; every other string is `false`. A number is `false` when `0` and `true` otherwise. `null` and `undefined` are `false`. |
| `text` | `null` and `undefined` become `""`; anything else takes its JavaScript string form (`2.5` is `"2.5"`, `true` is `"true"`). |

**Computed variables** hold no state. They are evaluated on every read from the current values of the non-computed variables, addressed by *name* (formulas below). Actions that name a computed variable MUST be ignored.

**Visibility.** `visible` defaults to `true` when absent (the `fantasy-series-quiz` sample omits it). `visible: false` means the variable SHOULD NOT be shown to the learner during play. A player MAY list it on an end screen or a debugging surface, marked as hidden. Visibility never affects evaluation.

**Actions.** A `VariableAction` `{variableId, operator, value}` MUST be applied as the table says. `variableId` names a variable by id; readers MAY also accept a variable name (the reference player does; the platform does not). An action whose variable does not exist, whose variable is computed, or whose operator is not in the table MUST be ignored (rule 5.1). Actions in one list are applied in array order, each seeing the effect of the last. After the operation the result is coerced to the variable's declared type, so `set_true` on a number variable stores `1`, `toggle` on a number variable stores `1` or `0`, and `increment` on a text variable stores the digits.

| Operator | Effect | Edge cases |
|---|---|---|
| `set` | the variable becomes `value`, coerced | a non-numeric string on a number variable stores `0` |
| `increment` | number(current) + number(`value`) | `value` absent: adds `1` |
| `decrement` | number(current) - number(`value`) | `value` absent: subtracts `1` |
| `multiply` | number(current) * number(`value`) | `value` absent: multiplies by `1` (no change) |
| `divide` | number(current) / number(`value`) | a divisor of `0`, absent, or non-numeric leaves the variable unchanged (the formula evaluator, by contrast, yields `0`) |
| `set_true` | `true` | |
| `set_false` | `false` | |
| `toggle` | not boolean(current) | |

**Placeholders.** A placeholder is `{` NAME `}` where NAME matches `[A-Za-z0-9_]+` and is a variable *name* (never an id). At render time a placeholder is replaced by the variable's current value in its text form (a computed variable is evaluated; a blank value becomes the empty string). A NAME that matches no variable MUST be left exactly as written, braces included. There is no escape: a literal `{score}` cannot be shown while a variable named `score` exists. Substitution MUST be applied to every string from the file that the learner reads as text: node titles, questions, instructions, `message.content` (before sanitising, 9.8), choice text, ranking and matching item text, procedure step text, reveal titles and bodies, and hotspot labels. It MUST NOT be applied to identifiers, URLs or media references. Because it happens at render time, a value shown reflects the variable at that moment.

**Formulas.** A computed variable's `formula` is arithmetic in this grammar (ASCII only; whitespace between tokens is ignored; any other character is a syntax error):

```
expression = term { ("+" | "-") term } ;
term       = factor { ("*" | "/") factor } ;
factor     = "-" factor | number | identifier | "(" expression ")" ;
number     = a run of digits and dots that parses as a decimal number (1, 2.5, .5) ;
identifier = (letter | "_") { letter | digit | "_" } ;
```

`+` and `-` are left-associative and bind loosest; `*` and `/` bind tighter; unary minus binds tightest and may repeat. Evaluation rules: an identifier resolves to the current value of the non-computed variable with that name, coerced to a number; an identifier that names no variable, or names a computed variable, evaluates to `0`; division by zero evaluates to `0`; a formula with a syntax error evaluates to `0` as a whole; a non-finite result is `0`. The result MUST be rounded to six decimal places, round half up (`round(x * 1e6) / 1e6`), which is what keeps `92 * 0.6 + 40 * 0.4` at `71.2` instead of `71.19999999999999`. The validator checks that a formula parses and references only real, non-computed variables; a player never rejects a file for a bad formula.

### 9.3 Conditions

One comparison serves three places: a `condition` node's criteria sets, the completion rule (9.4), and a scene's `abortWhen` (9.6).

**Operators.** Before matching, an operator is trimmed, lower-cased, and every underscore is replaced by a space, so the canonical spelling and the space-separated legacy spelling are the same operator. Writers MUST emit the canonical spelling; readers MUST accept both spellings, and SHOULD accept the aliases in the third column, which do not appear in exported files. An operator not in the table evaluates to false.

| Canonical | Legacy spelling | Aliases | True when |
|---|---|---|---|
| `exists` | | | the value is not blank |
| `not_exists` | `not exists` | | the value is blank |
| `is_true` | `is true` | | the value's boolean form is true |
| `is_false` | `is false` | | the value's boolean form is false (a blank value satisfies this) |
| `equals` | | `==`, `=`, `eq`, `is` | any candidate equals the expected string, or the value is a number equal to number(expected) |
| `not_equals` | `not equals` | `!=`, `<>`, `neq`, `is not`, `does not equal` | `equals` is false |
| `contains` | | | the expected string is split on commas into trimmed, non-empty items; true when any item is a substring of any candidate |
| `not_contains` | `not contains` | `does not contain` | `contains` is false |
| `starts_with` | `starts with` | | any candidate starts with the expected string |
| `ends_with` | `ends with` | | any candidate ends with the expected string |
| `>`, `<`, `>=`, `<=` | | `gt`, `lt`, `gte`, `lte` | number(value) compared with number(expected); a list or a non-numeric value is false |
| `length_>` | `length >` | | the value's length (a list's element count, otherwise its string length) is greater than number(expected) |
| `length_<` | `length <` | | the same, less than |
| `before` | | | Date(value) is earlier than Date(expected) |
| `after` | | | Date(value) is later than Date(expected) |
| `within_range` | `within range` | | expected is `"a, b"`: Date(a) <= Date(value) <= Date(b) |

For every operator except the first four a blank value is false. The *boolean form* used by `is_true` and `is_false` is: a string is true when, trimmed and lower-cased, it is `true`, `yes` or `1`, false when it is `false`, `no`, `0` or empty, and true for any other non-empty string; any other value follows JavaScript truthiness. (This is wider than the storage coercion of 9.2, which only knows `true`, `yes` and `1`; the two rules are what the reference player does.)

**Values.** The expected value is the string form of `value` (`null` is the empty string), so `"1"` and `1` compare alike; numeric operators convert both sides (that is what makes `"value": "60"` in the samples work). The *candidates* for the string operators are: each element's string form when the value is a list, otherwise the value's string form; plus, when the field resolves to a node answer that has labels, each label. That is what lets an author write the visible text of a choice instead of its generated id.

**Fields.** `field` is resolved in this order: a variable id; a variable name (a reader tolerance, as for actions); a node id, or a nested interaction id `<sceneId>/<hotspotId>` (9.6), whose recorded answer is the value and whose choice labels (for `choice` and `multipleChoice` answers) are the extra candidates; otherwise blank. A computed variable is evaluated. A node that has not been answered is blank. The literal field `"operator"` is a connector, below.

**Combining conditions.** A criteria set is its `conditions[]` in array order, read as tokens. A condition whose `field` is exactly `"operator"` is a connector: its `value`, trimmed and upper-cased, is `AND`, `OR`, `NOT`, `(` or `)`; a connector with any other value is dropped. A condition carrying `join: "AND"` or `join: "OR"` contributes that connector before itself unless it is the first token. The tokens form this expression:

```
expr    = and { "OR" and } ;
and     = not { [ "AND" ] not } ;        two operands with no connector between them are joined by AND
not     = "NOT" not | primary ;
primary = "(" expr [ ")" ] | condition ;
```

Precedence is NOT, then AND, then OR; parentheses group. A missing closing parenthesis is tolerated; a stray token where an operand is expected is skipped. A set with no conditions is false. Evaluation has no side effects, so short-circuiting is not observable.

**Routing.** Criteria sets are tried in array order. The first set that is true *and* has a non-empty `targetNodeId` wins (a true set with no target is skipped). If none wins the node routes to `defaultTargetNodeId` when non-empty, else along its forward edge, else the experience ends. The chosen target SHOULD be recorded (the reference player's `branch-taken`). A condition node is never presented; it is entered and left like any node (9.1), so its triggers fire and it appears in the path.

**Completion and abort comparisons** use the same table with the variable's value as the only candidate (no labels).

### 9.4 Completion and scoring

**Node grades.** A node's score is a whole number from 0 to 100, produced only by the types below. Every other type (`message`, `video`, `choice`, `textInput`, `multipleChoice`, `ranking`, `rating`, `scene`, `note`, `condition`, `code`) has no notion of a correct answer in this format and carries no score. A nested interaction (9.6) is graded by the same rules under its sub-node id.

| Type | Score | When |
|---|---|---|
| `matching` | round(100 * correct / scorable), where *scorable* is the number of left items with a `correctRightId` and *correct* those matched to exactly that right id | on submit, when `matchingGraded` is not `false` and scorable > 0; otherwise no score |
| `procedure` | round(100 * inTurn / steps), where *inTurn* is the number of steps performed in turn (performed minus missteps) and *steps* the authored count | when every step has been performed, or the procedure halted on a critical misstep |
| `dragToTarget` | round(100 * right / items), where an item with a `targetId` is right when placed on it and a distractor (no `targetId`) is right only when left unplaced; an empty item list scores 100 | on submit |
| `conversation` (connected) | the receiver's assessment score, rounded and clamped to 0 to 100 | when the conversation is assessed |

**The completion rule** (`settings.completion`) is evaluated once, when the experience ends, against the final state. `mode` defaults to `variable` when absent or unrecognised.

- `variable`: `passed` is the 9.3 comparison of the variable `variableId`'s current value with `operator` and `value`. When the variable does not exist or `operator` is absent or empty there is no verdict. The validator restricts authors to `<`, `>`, `<=`, `>=` on numbers, `is_true` and `is_false` on booleans and `contains` on text; a player MUST evaluate whatever 9.3 operator it is given.
- `reachedNode`: `passed` is true when `passNodeId` is non-empty and that node was entered at any point in the session (notes are never entered), false otherwise.
- `nodeScore`: the compared value is the score of `scoreNodeId` when that field is given, else the aggregate of all node scores under `scoreAggregate`, which is `average` (the default), `min`, `max` or `sum`. When the named node has no score, or there are no node scores to aggregate, `passed` is false. Otherwise `passed` is the 9.3 comparison with `operator` and `value` when `operator` is present, and value >= number(`value`) when it is not (`0` when `value` is absent).

With no rule at all the end state is "completed" with neither pass nor fail. `certificate` and `certificateValidityMonths` describe platform issuance and MUST NOT affect the verdict; a player MAY mention them.

**What "score" means at the end.** The session score shown and recorded is: in `nodeScore` mode, the compared value rounded (when defined); otherwise, when any node scores exist, the rounded mean of all of them; otherwise, in `variable` mode, the rule's variable's value when it is a number (a raw number, such as `3` on a variable that counts errors, not a percentage, so a player SHOULD label it by the variable's name); otherwise no score. Node scores are additionally reported per node, keyed by node id or sub-node id.

**Records built locally.** A player that builds xAPI-shaped statements with no learner identity SHOULD use the placeholder actor `{"account": {"name": "local"}}` and no registration, the activity IRIs of §3, and the hotspot sub-activity `{activityIri}/nodes/{sceneId}/hotspots/{hotspotId}` for nested answers. The reference player's extension keys (`answer-labels`, `variable-changed`, `branch-taken`, `scene-hotspot`, `scene-miss`, `timer-expiry`, `procedure-step`, all under `https://ronunest.com/xapi/ext/`) MAY be emitted by any player. The smaller platform-native body a player sends to a record receiver is defined in [`docs/record-receiver.md`](../docs/record-receiver.md) §3.

### 9.5 Triggers and timers

**NodeTrigger** `{type, actions[], config}` entries live in `config.triggers[]`. Triggers of an unknown type MUST be ignored.

| `type` | Fires | `config` |
|---|---|---|
| `onNodeEnter` | on entry, before the node's timer starts and before it is presented | none |
| `onNodeExit` | on leaving along any edge (Continue, a choice, a condition route, a hotspot route, a scene abort, a timer `advance` or `route`); not on an in-place `end`, and never on a note | none |
| `onTimerElapsed` | once, `config.duration` seconds after entry (readers MUST also accept `config.seconds`; when neither is a number the delay is 30 seconds). It is independent of `timer`. Only the first `onTimerElapsed` trigger in array order is honoured | `duration` |
| `onVideoComplete` | each time a natively played `video` node's media reaches its end | none |
| `onVideoTimestamp` | once per visit, the first time playback reaches `config.timestamp` seconds (`0` when absent) | `timestamp` |

The video triggers need playback the player can observe; on an embedded page player (9.8) they do not fire. An `onTimerElapsed` trigger firing inside a scene re-evaluates `abortWhen` (9.6).

**TimerConfig** `{mode, seconds, visible, label, warnAtSeconds, sound, onExpire{behavior, targetNodeId, actions}, recordVariableId}` appears as a node's `config.timer` (started on entry) and as `settings.timer`, the module timer (started at launch). A timer with no `mode` is not a timer. Defaults: `visible` is `true`; `warnAtSeconds` is `10`, and a player SHOULD mark a countdown as warning while the remaining time is above zero and at or below it; `sound` MAY be ignored (the reference player ignores it). A `countup` timer never expires and its `onExpire` MUST be ignored (the validator warns). A `countdown` expires once, when the elapsed wall-clock time reaches `seconds`; `seconds` that is not a positive number never expires. A player SHOULD check its timers at least four times a second.

**On expiry** the player MUST apply `onExpire.actions` first, then, for a node timer inside a scene, re-evaluate `abortWhen` (an abort takes precedence over the behaviour), then apply `onExpire.behavior`:

| `behavior` | Node timer | Module timer |
|---|---|---|
| `none` (default) | the node stays; the timer shows as expired | the same |
| `advance` | leave along the node's forward edge (the experience ends when it has none) | has no meaning for a module (the validator warns); MUST be treated as `end` |
| `route` | leave for `targetNodeId`, falling back to the forward edge, else the experience ends | leave the current node through its normal exit for `targetNodeId`; the experience ends when it is empty |
| `end` | the experience ends in place: the node's `onNodeExit` triggers do not fire and its own `recordVariableId` is not written | the experience ends |

Expiry does not wait for the learner: an open card or beat is discarded with the node.

**`recordVariableId`.** When set, the elapsed whole seconds since the timer started (rounded) are written to that variable with a `set` action: for a node timer when the node is left along any edge, for the module timer when the experience ends. It is written for `countup` timers too; it is not written for a node timer whose `end` behaviour ended the experience in place.

### 9.6 Scenes

**Environment.** `environment.kind` is `photo360` or `photo2d` (stable); `splat` and `embed3d` are provisional and a minimal player treats such a scene as unsupported (9.1). A scene whose `environment` or `kind` is absent or empty MUST be played as `photo360`. A scene whose `source` is empty or cannot be resolved MUST still be played, on a neutral backdrop, with every hotspot working (the `under-the-sink` sample).

**Positions.** For `photo360` a hotspot's `position` is `{yaw, pitch}` in radians. Yaw 0 is the centre column of the equirectangular image, positive to the right; pitch 0 is the horizon, positive up, in the range -π/2 to π/2. Yaw is periodic: readers MUST treat two yaws that differ by a multiple of 2π as the same direction (the `showcase` sample carries a yaw of 3.40), and writers SHOULD emit yaw within -π to π. Image mapping is presentational: a player SHOULD place yaw and pitch at `u = (yaw / 2π + 0.5) * width`, `v = (0.5 - pitch / π) * height` on the equirectangular image, and MAY draw the image as a flat pan or a perspective projection; two players with different projections show the same hotspot at slightly different screen places, and only the angular convention above is normative. For `photo2d` the position is `{x, y}`, fractions from 0 to 1 of the image's width and height measured from its top-left corner. A hotspot with no usable position cannot be found by tapping the scene; a player SHOULD still make it activatable.

**Distance and discovery.** Distance between a tap and a hotspot is the great-circle angle for `photo360` (`acos(sin p1 sin p2 + cos p1 cos p2 cos(y1 - y2))`) and the Euclidean distance in fraction units for `photo2d`. `discoveryRadius` is in the same units and defaults to `0.35` radians for `photo360` and `0.08` for `photo2d`; a value of `0` or a non-number takes the default.

**Hidden hotspots.** A hotspot with `hidden: true` shows no marker until found. When the learner taps the scene at a point, the candidates are the hidden hotspots that have not yet been visited and have a usable position; the nearest candidate within `discoveryRadius` is found. If that hotspot is locked (below) the tap does nothing beyond saying so, and no miss is recorded; otherwise it is activated as if its marker had been tapped. With no candidate in range the tap is a *miss*: `missActions` fire, `abortWhen` is re-evaluated, and the miss SHOULD be recorded. Visible hotspots are activated by their marker and are never discovery candidates. The platform's legacy scene-wide `hotspotVisibility: "hidden"` field is not part of this format and the reference player ignores it.

**Activation.** While a card (a beat, below) is open, taps and activations are ignored. In `hotspotSequence: "ordered"` a hotspot is *locked* until every hotspot earlier in the `hotspots` array has been visited; activating a locked hotspot is refused and has no other effect. On a hotspot's *first* activation the player MUST: mark it visited (and found, when hidden); fire its `variableActions` once and never again; record the activation; re-evaluate `abortWhen`, and stop here if it fires. Then, on every activation, the beats run in this order, each as a card the learner dismisses before the next: `conversation` (present when `persona` or `firstMessage` is non-empty; a minimal player shows the rule 5.2 fallback card, a connected player runs the character per [record receivers](../docs/record-receiver.md) §4), `interaction` (present when its `type` is one of the nestable types of §7.2; any other type is ignored), `reveal` (present when the field is set), and finally the *route*: when `targetNodeId` is non-empty the scene is left for it through the normal exit (9.1), otherwise the learner stays in the room.

**Dismissal.** Dismissing a card runs the next beat, with two exceptions that drop the rest of that activation's beats and return the learner to the room: a live conversation that has not been ended, and an interaction that has not been answered. Opening the hotspot again shows the pending card again; once it is ended or answered, dismissing runs the remaining beats (reveal, then route). A `message` interaction is answered by reading it, so dismissing it is an answer. An answered interaction cannot be answered again; reopening it shows the recorded answer and then the later beats.

**Reveal.** `reveal` is `{kind, title, body, src}` with `kind` one of `text` (the default), `image` or `video`; `src` is a media reference (readers MAY also read `url` or `source`); `body` and `title` are subject to placeholders, and `title` defaults to the hotspot label. A player MUST show the body and SHOULD show the media; when the media cannot be resolved it says so.

**Required, completion, sequence.** A hotspot is *satisfied* when it has been visited and, if it carries an interaction, that interaction has been answered; a hotspot whose only beat is a conversation is satisfied by visiting, in both minimal and connected players. With `completion: "allRequired"` Continue MUST be withheld until every hotspot with `required: true` is satisfied; with `completion: "free"` (the default) `required` has no effect on leaving the scene. `hotspotSequence: "ordered"` locks on *visited*, not answered, so the two rules stay independent: an earlier required interaction left unanswered does not lock the next hotspot, it only holds up Continue. The default sequence is `free`.

**Interactions** (§7.2). The nested sub-node is identified as `<sceneId>/<hotspotId>`: its answer and any score are keyed by that id, a condition `field` may name it, and its xAPI object is the hotspot sub-activity (9.4). It is answered by the same rules as the top-level type (9.7) and graded the same (9.4); the per-choice, per-match and per-step `actions[]` in its config fire as usual. Of the nested `config`, only the answer fields and those `actions[]` are honoured: `connection`, `advanceOnAnswer`, `showContinueButton`, `triggers`, `timer`, `required`, `allowPrevious` and `isStart` MUST be ignored, because the sub-node is never entered or left as a node, never routes, and the hotspot's own `required` governs. "Answered" for an empty question follows the top-level rule: an empty `multipleChoice`, `ranking`, `matching` or `dragToTarget` submission still counts as an answer (a `dragToTarget` with nothing to place scores 100), while a `procedure` with no steps can never be completed, so a required hotspot carrying one is a gate that never opens; the validator flags both. A nested `procedure`'s `earlyActions` fire at the moment of the misstep and re-evaluate `abortWhen`, so a critical misstep can eject the learner mid-procedure with the procedure unanswered.

**Early exit.** `abortWhen` is `{variableId, operator, value, targetNodeId}` with `operator` defaulting to `is_true`; the comparison is 9.3's. The rule never fires when `targetNodeId` is empty or `variableId` names no variable (the validator warns). It is evaluated after every event inside the scene that can fire actions, whether or not the event actually carried any: a hotspot's first activation, a miss, a nested interaction's answer, each step of a nested procedure, the assessment of a hotspot conversation, an `onTimerElapsed` trigger, and a node timer expiry. It is not evaluated on entry, so a value already over the line when the scene is entered is noticed at the first tap, which keeps a debrief that loops back into the room from bouncing the learner straight out again. When it fires the player MUST close any open card, record the abort, and leave through the normal exit (`onNodeExit` triggers, the timer's `recordVariableId`) for `targetNodeId`; the scene's forward edge and the hotspot's remaining beats are not followed.

**Conversation scores in a minimal player.** A minimal player writes nothing to a conversation's or a hotspot character's `scoreVariableId`; the variable keeps its value. Authors SHOULD NOT gate the only route to the end on such a score (the advice of rule 5.2 applies): the `margarets-room` sample can only end through its `abortWhen` exit without an AI grader.

### 9.7 Node-type notes

What each catalogue type presents, what "answered" means for it, what it records as its answer, and how it leaves. Scores are in 9.4.

- **`message`.** Presents `content` (9.8) and `files[]`. Answered by reading; records nothing. The Continue affordance MUST be shown unless `showContinueButton` is `false` *and* the node has another way out: a `countdown` timer whose `onExpire.behavior` is `advance`, `route` or `end`, or `advanceOnAnswer: true` on a node that can be answered. A file can therefore never strand the learner behind a hidden button.
- **`video`.** `videoUrl` is resolved as in 9.8. A YouTube or Vimeo *page* URL (hosts `youtube.com`, `youtube-nocookie.com`, `youtu.be`, `vimeo.com`, `player.vimeo.com`) SHOULD be embedded through the host's player; any other resolvable reference plays natively. `subtitlesUrl` becomes a subtitle track, on unless `videoControls.showSubtitles` is `false`; `thumbnailUrl` is the poster; `videoControls.autoplay` is honoured; the other `videoControls` flags MAY be ignored. An unresolvable video is reported, not fatal. Watching never gates Continue. Records nothing.
- **`choice`.** Presents `question` and `choices[]{id, text, connection, actions[]}` as options; there is no Continue. Choosing records the choice `id` as the answer with its `text` alongside as a label (a choice with no id records its text), fires that choice's `actions[]`, and leaves along the choice's `connection`, else the node's forward edge. `choices[].condition` has no defined meaning and MUST be ignored.
- **`textInput`.** Records the submitted string, which may be empty.
- **`multipleChoice`.** Records the list of chosen choice ids, with their labels alongside; ids not in `choices[]` are dropped, and when `allowMultiple` is not `true` at most one (the first chosen) is kept. After recording, each chosen choice's `actions[]` fire in the order chosen. With `advanceOnAnswer` a single-select pick answers and leaves at once; with `allowMultiple` a submit is still needed.
- **`ranking`.** `rankingItems[]` are strings; readers MAY accept objects, taking `text`, else `label`, else `id`. The answer is the full ordered list of item texts; items the learner did not place are appended in authored order. There is no correct order.
- **`matching`.** `matchingLeftItems[]{id, text, correctRightId, actions[]}` and `matchingRightItems[]{id, text}`. The answer is the map from left id to right id. A right item MAY be matched by more than one left item. On submit each left item matched to exactly its `correctRightId` fires its `actions[]` once, in left-item order. `matchingGraded` defaults to `true`.
- **`rating`.** `ratingMin` defaults to `1` and `ratingMax` to `5`; a value outside the range is refused. The answer is the number; it is then written to `ratingVariableId` with a `set` action. `ratingStyle` (`stars`, `numbers`, `emoji`, with `ratingEmoji` the glyph for the emoji style) and the low and high labels are presentational. A rating does not leave by itself unless `advanceOnAnswer` is set.
- **`condition`.** Routes per 9.3; never presented; enters and leaves like any node.
- **`procedure`** (provisional). `procedureSteps[]{text, critical, ifEarly, earlyActions[]}`; a plain string is a step with only `text`. The authored order is the correct order and MUST NOT be shown as such: a player SHOULD present the steps in another order (the reference player shuffles deterministically from the node id). The expected step is the first not yet performed, in authored order; performing any other step is a *misstep*: its `ifEarly` message SHOULD be shown, its `earlyActions` fire at that moment, and the misstep is recorded; when the step is `critical` and `procedureHaltOnCritical` is `true` the procedure halts. A step can be performed once. The procedure is answered when every step has been performed or it has halted; the answer is `{order, missteps, halted}` (authored indices in the order performed, the indices that were missteps, and whether it halted). Continue follows.
- **`dragToTarget`** (provisional). `dragTargets[]{id, label, image}` and `dragItems[]{id, label, image, targetId}`; `image` is a media reference. Placements may change until submit; submit records the map from item id to target id (unplaced items absent) and the score. Continue follows. Players SHOULD implement it as tap-to-place (§7).
- **`note`.** Never presented; skipped silently (9.1).
- **`scene`.** 9.6. Records nothing itself; nested answers are recorded under their sub-node ids.
- **`conversation`** (provisional). A minimal player shows the fallback card and records nothing. A connected player runs it through the receiver ([record receivers](../docs/record-receiver.md) §4) and records `{messages, assessment}` with the assessment's score as the node score, written to `scoreVariableId` with a `set` action.
- **`code`** (provisional). The fallback in a player without a sandbox; §7.1 says how its bindings are to be read. Nothing here defines its answer.
- **Unknown and extension types.** The rule 5.2 fallback; visited, no answer.

`advanceOnAnswer` applies to `textInput`, `multipleChoice`, `ranking`, `matching`, `rating` and an assessed `conversation`: answering leaves along the forward edge at once. It does not apply to `procedure` or `dragToTarget`, which show their result first, nor to a nested interaction.

### 9.8 Media and content

**Reference forms.** The canonical reference is a bundle path `assets/<name>` (§8). Readers MUST also resolve a path with one leading `./` or `/` removed, MUST try both the path as written and its percent-decoded form against the zip entries, MUST pass absolute `http://` and `https://` references through unchanged (playable online only), and MUST pass `data:` and `blob:` references through; a protocol-relative `//host/path` is read as `https:`. Anything else (a platform storage ref) resolves to nothing. The MIME type of a bundled asset is the manifest's `assets[].mimeType` for that path, else inferred from its extension.

**Failure rendering.** A reference that resolves to nothing MUST NOT abort the node: an image shows its `alt` text or nothing, a video says it is not bundled, an attachment shows its name marked as not bundled, a scene backdrop is neutral (9.6).

**HTML in `message.content`.** The file is untrusted by design, so `content` MUST be sanitised by allowlist and MUST never be inserted into a document raw. Conformance-relevant: a player MUST render at least the kept elements below with the listed attributes, MUST drop the dropped elements with their contents, MUST NOT run or embed any active content, and MUST copy no attribute that is not listed (so no event handlers, no `style`, no `class`). The exact set is otherwise presentational and SHOULD be this one:

| Treatment | Elements | Attributes kept |
|---|---|---|
| kept | `p`, `br`, `strong`, `em`, `u`, `ul`, `ol`, `li`, `h1`, `h2`, `h3`, `h4`, `blockquote`, `code`, `pre` | none |
| kept | `a` | `href`, only when it is `http://` or `https://`; the link SHOULD open in a new context with `rel="noopener noreferrer"` |
| kept | `img` | `src`, only a bundle path or an `http(s)://` URL (a `data:` URI or an unresolvable reference is replaced by the `alt` text); `alt` |
| renamed | `b` to `strong`, `i` to `em`, `h5` and `h6` to `h4` | |
| dropped with contents | `script`, `style`, `iframe`, `object`, `embed`, `template`, `svg`, `math`, `noscript`, `link`, `meta`, `base`, `form`, `input`, `button`, `textarea`, `select`, `video`, `audio`, `source`, `frame`, `frameset`, `applet`, `canvas`, `head`, `title` | |
| unwrapped | every other element: its text and allowed descendants survive, the element itself does not | |

Comments are dropped. Placeholder substitution (9.2) happens before sanitising, so a variable's text is subject to the same allowlist.

**`files[]`.** Each entry is `{id, name, path, mimeType}`; the legacy `data` form (a base64 data URL, §8) MUST also play, and readers MAY read `url`. Attachments SHOULD be presented as a list, each shown by `name` (else `path`) and linking to the resolved bytes; an attachment that cannot be resolved is listed by name and marked as not bundled. An image referenced from `content` renders inline as well.

### 9.9 Container tolerance

Writers MUST emit the container of §2 exactly. Readers tolerate the following:

- **A folder-prefixed zip** (a zip made from a folder, so every member sits under one directory). When `manifest.json` and `module.json` are not both at the root, the first member whose path ends in `/module.json` sets a prefix; the manifest, the module and the assets are then read relative to it, and asset references resolve against the prefixed paths. Members under `__MACOSX/`, directory entries, and members whose name begins with a dot are ignored.
- **No `module.json`.** The file is not a `.ronu`; the reader MUST refuse it with a message.
- **No `manifest.json`.** A reader MUST NOT refuse the file. It synthesises a minimal envelope: `{"format": "ronu", "formatVersion": "0.9", "module": {"familyId": "local:<file name>", "title": <the start node's title, else the file name>}, "activityIri": "urn:ronu:local:<encoded file name>", "assets": []}`. Such a file plays fully, and its local records use the `urn:` IRI, but it has no version id and therefore cannot be sent to a record receiver ([record receivers](../docs/record-receiver.md) §3). The JSON-only interchange form (a bare `module.json`, §2) is opened the same way; a `manifest.json` found beside it MAY be used as its envelope so it keeps its identity.
- **Envelope problems.** `format` other than `"ronu"`, or a missing `module.familyId` or `module.title` (§3), SHOULD be reported and MAY be played through.
- **Encoding.** Both JSON members are UTF-8; a leading byte-order mark is tolerated.
- **`formatVersion`.** During the unversioned draft phase a reader MUST accept major versions `0` and `1`, and on any other major MUST warn and continue rather than refuse (§3, §6).

## 10. What the spec does NOT define

Learner records and reporting (that's xAPI's job; the envelope carries the activity IRIs it needs), DRM (deliberately none; access control is a platform concern), rendering/theming (§9 says what a player does, never how it looks), the AI backends behind `conversation`, and platform services (groups, certificates, analytics). Open format, closed platform.

## 11. Appendix: guidance for editor/platform implementers

Look-and-feel is not the format's business: fonts, animations, transitions, layouts are all player-side, and players are *supposed* to compete on feel. Only three kinds of product change touch the format, in ascending order of care:

1. **New authoring options that must travel with the file** (a theme, background audio, a layout variant) → **new optional config fields**: purely additive, covered by must-ignore (rule 5.1).
2. **New interaction patterns** → a **new node type**: additive catalogue entry, `provisional` at first.
3. **Reshaping existing fields**: the only dangerous one. That is a *meaning change*, forbidden for `stable` entries, so it must go through the canonical/legacy mechanism (§5.4/§8).

The one-question discipline: **"is this a player behaviour, or an author's choice that must survive export?"** Player behaviour → not in the file. Author choice → additive optional config field.

## 12. Road to v1.0

1. Freeze the **skeleton** (§2–§6); nothing in it is contentious.
2. **Done (September 2026): write the player semantics down.** The [reference player](../player) was written from the spec alone, and everything it had to decide for itself is now normative text in §9. An independent implementer can build a player from the text and get the reference player's behaviour on every sample.
3. **Next gate: a conformance suite.** §9 is normative but only the reference player's own tests exercise it. The suite is a set of files plus scripted answers and the expected end state (path, variables, verdict, node scores) that any player can be driven through; the samples and the reference player's test fixtures are its seed. A `v1.0` is not cut before it exists.
4. Let the catalogue's `provisional` entries (code/3-D, conversation visuals, `procedure`, `dragToTarget`) settle; re-tag as `stable` when their configs stop moving.
5. Cut `v1.0` = frozen skeleton + §9 + the then-stable catalogue; start versioning, and publish the crate + generated bindings (npm, PyPI).
