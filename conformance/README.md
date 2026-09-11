# The `.ronu` conformance suite

A language-neutral set of module files, scripted plays and expected outcomes. Any player implementation can run them to prove it agrees with the reference player on the things the spec leaves open. Each case pins one decision from [`player/SPEC-GAPS.md`](../player/SPEC-GAPS.md) (the `gaps` field names it) or one rule from [`spec/ronu-spec.md`](../spec/ronu-spec.md) (the `spec` field names the section). When the spec later absorbs a decision, the case is already there to hold the line; when a decision is overturned, the case is the place to change it, and the diff shows exactly what moved.

The suite is data. Nothing in `cases/` is JavaScript; the two runners here are adapters for the two players that live in this repository, and section 5 says how to write one for yours.

## 1. Layout

```
conformance/
  README.md              this file
  cases/<id>/module.json the experience under test (JSON-only interchange form, spec section 2)
  cases/<id>/case.json   what to do to it and what must come out
  lib/compare.mjs        the comparison rules, unit tested (lib/compare.test.mjs)
  lib/cases.mjs          loader, skip rule, outcome checker, table printer (shared by the runners)
  run-reference.mjs      drives player/engine.js through every case
  run-tiny.mjs           drives docs/examples/tiny-player.mjs through the cases it can play
  validate-cases.mjs     runs the reference validator over every module.json
```

Cases are grouped by id prefix: `walk-` (start rules, ending, dangling edges, legacy types), `variables-` (actions, coercion, defaults, computed formulas, placeholders), `conditions-` (operators, fields, connectors, no-match rules), `completion-` (each mode and operator), `grades-` (matching, procedure, dragToTarget scores), `triggers-` and `timers-`, `scenes-` (hotspots, discovery, nested interactions, `abortWhen`), `answers-` (what each node type records) and `evolution-` (spec section 5).

No case carries a `manifest.json`: everything here plays from `module.json` alone, and none of the pinned decisions depends on the envelope. The container rules (zip layout, synthesised manifests, G34 to G36) are covered by the reference player's own tests in `player/test/bundle.test.mjs`.

## 2. The case format

```json
{
  "id": "conditions-implicit-and",
  "title": "Two adjacent conditions with no connector combine with AND",
  "spec": ["7"],
  "gaps": ["G3"],
  "level": 1,
  "requires": ["message", "condition"],
  "validator": { "errors": [] },
  "play": [ { "at": "start" }, { "continue": true }, { "continue": true } ],
  "expect": { "trail": ["a", "c1", "c2", "yes"] }
}
```

- `id` matches the folder name. `title` says what is being pinned, in one sentence.
- `spec` lists the spec sections involved; `gaps` lists the SPEC-GAPS entries the case pins (empty when the spec itself is explicit).
- `level` is the conformance level (spec section 6) at which the case applies: `1` for a minimal player, `2` when the case needs a provisional type (`procedure`, `dragToTarget`, `conversation`).
- `requires` lists what the case needs: node types, plus feature tags (section 4). A player that does not implement one of them skips the case.
- `validator` is present only when the module is deliberately one the reference validator rejects (section 6).
- `play` is the script, a list of steps run in order (section 3).
- `expect` is what must be true at the end of the play. Every key is optional; only the keys listed are checked (section 3).

### 3. Play steps and expected outcomes

Steps, one per object, and the reference engine call each maps to:

| Step | Meaning |
|---|---|
| `{"at": "start"}` | start the module (`start()`) |
| `{"continue": true}` | follow the default connection (`continue()`); a refused Continue is not an error, the play simply stays put |
| `{"choose": "c1"}` | pick a choice by id on a `choice` node |
| `{"answerText": "hello"}` | answer a `textInput` |
| `{"answerMultiple": ["a", "b"]}` | answer a `multipleChoice` with choice ids |
| `{"answerRanking": ["b", "a"]}` | answer a `ranking` with item labels in order |
| `{"answerMatching": {"l1": "r1"}}` | answer a `matching` with left id to right id |
| `{"answerRating": 3}` | answer a `rating` |
| `{"performStep": 0}` | perform a `procedure` step by its index in the authored list |
| `{"placeItem": ["item", "target"]}` | place a `dragToTarget` item (`null` target removes it) |
| `{"submitPlacements": true}` | check the placements |
| `{"activateHotspot": "h1"}` | tap a visible scene hotspot |
| `{"tapScene": {"yaw": 0, "pitch": 0}}` | tap the scene itself (discovery); `{"x", "y"}` for `photo2d` |
| `{"dismissBeat": true}` | close the open card (conversation, interaction or reveal) |
| `{"answerConversation": {"score": 80}}` | the assessment a receiver would return for a `conversation` node; add `"hotspot": "h1"` for a hotspot character |
| `{"elapse": 3}` | advance the clock by that many seconds and let timers run |

While a scene's interaction card is open, the answer steps apply to the nested interaction, exactly as they would to a top-level node of that type.

Expected outcome keys, all optional:

| Key | Compared against |
|---|---|
| `trail` | the ids of the nodes entered, in order; `note` nodes never appear, `condition` nodes do |
| `current` | the id of the node the play stopped on, or `null` once the experience has ended |
| `variables` | the value of each named variable (by `name`, computed ones included) |
| `end` | `{passed, score, reason, error}` once the experience has ended; listing `end` when the play has not ended fails the case |
| `nodeScores` | node id to 0 to 100 score; a nested answer is keyed `<sceneId>/<hotspotId>` |
| `answers` | node id to the recorded answer, keyed the same way |
| `events` | an ordered subsequence of the session log (see below) |
| `view` | the node on screen when the play stopped: `nodeId`, `title`, `content`, `question`, `instructions`, `canContinue`, `supported`, with placeholders substituted |

`end.reason` uses a small vocabulary: `end` (a node with no forward edge), `dangling` (an edge to a node that does not exist), `timer` (a timer's `end` behaviour), `no-start` (an empty module), `loop` (a pass-through cycle). `end.error` is a boolean: did the experience end because of a fault in the file. `end.passed` is `true`, `false` or `null` (no completion rule).

Comparison rules (`lib/compare.mjs`):

- numbers are equal within 1e-6;
- strings, booleans and `null` are exact;
- arrays are ordered and exact in length;
- objects compare by the keys the expected object lists; extra keys on the actual side are ignored; an empty expected object (`{}`) means "nothing recorded" and requires an empty actual object;
- `events` is the one subsequence match: each expected event must appear, in the same relative order, matched on the keys it lists. Event types used: `entered`, `exited`, `answered`, `variable`, `branch`, `hotspot`, `hotspot-read`, `scene-miss`, `scene-abort`, `procedure-misstep`, `timer-expiry`.

`view` is the one key that a headless harness might not be able to produce; a player whose adapter cannot expose rendered text may skip the cases that list it and must say so in its conformance statement.

## 4. Levels, feature tags and skipping

A case is skipped, not failed, when the player does not support something the case needs. There are two ways that can be so:

- `level`: a level-1 player skips every level-2 case.
- `requires`: a player declares the node types and feature tags it implements; a case that lists one it lacks is skipped.

The feature tags beyond node types are: `triggers` (`onNodeEnter`, `onNodeExit`, `onTimerElapsed`), `timers` (node and module `TimerConfig`), `clock` (the harness can advance a synthetic clock, needed by every case that uses `elapse`), `computed` (computed variables), `placeholders` (`{name}` substitution, checked through `view`), `coercion` (the G27 rules for mismatched value types).

The rule for claims: **a level-1 player must pass every level-1 case.** Skipping is for a harness limitation (no controllable clock, no way to read rendered text), and a conformance statement lists what was skipped and why. A player that skips a level-1 case because it does not implement a stable node type is not a level-1 player. A level-2 player passes every case for the provisional types it declares.

## 5. Running the suite

Against the reference player (Node 20 or later, no install):

```bash
node conformance/run-reference.mjs             # every case, PASS/FAIL/SKIP table, exit 1 on any FAIL
node conformance/run-reference.mjs --only scenes
node conformance/run-reference.mjs --verbose   # print each outcome beside its row
node --test conformance/lib/*.test.mjs         # the comparison rules
```

Against the tutorial player (`docs/examples/tiny-player.mjs`, a terminal program with no API):

```bash
node conformance/run-tiny.mjs
```

The tiny player implements the skeleton, `message`, `choice`, `condition` and `note`, variables and actions, and nothing else, so the runner plays only the cases whose `requires` stay inside that set. It is a black-box adapter: `choose` steps become the `ANSWERS` index list the player reads from its environment, and the end state it prints (the `name = value` lines and the pass line) is what gets compared, so it checks `variables` and `end.passed` and reports what it checked on each row. The point of running a second, independent implementation is to show the case files pin behaviour rather than one engine's habits.

Against the reference validator (needs a Rust toolchain):

```bash
node conformance/validate-cases.mjs
RONU_BIN=rust/target/debug/ronu node conformance/validate-cases.mjs   # a prebuilt binary
```

All three run in CI (the `conformance` job in `.github/workflows/ci.yml`).

## 6. Writing an adapter for your own player

An adapter does three things; `run-reference.mjs` is the model, and it is a hundred lines.

1. **Declare capabilities.** `{level, requires}`: the level you claim and the node types and feature tags you implement. Pass each case through the skip rule (`skipReason` in `lib/cases.mjs`, or its one-paragraph equivalent in your language: skip when `case.level` is above yours or when `case.requires` names something you lack).
2. **Drive the play.** Load `module.json`, start, and map each step in `play` to your player's calls. A step your player rejects (an unknown choice id, a rating out of range) is a failure of the case, not a skip. Use a synthetic clock for `elapse`; if you have none, do not claim the `clock` tag.
3. **Report the outcome** in the shape section 3 lists and compare it against `expect` with the rules in `lib/compare.mjs` (port them; they fit on a page). Print a row per case and exit non-zero on any FAIL.

Some outcome keys are engine bookkeeping you may need to add: a `trail` (the node ids entered, in order, without notes), a session log with the event types above, answers keyed by node id (nested ones by `<sceneId>/<hotspotId>`), and per-node scores. All of them are things a player needs anyway to emit the records the spec's xAPI note describes.

A conformance statement then says: the level claimed, the capabilities declared, the suite commit, the table, and the reasons for any skips.

## 7. What the validator says about the cases

Every `module.json` here validates with zero errors under the reference validator, warnings allowed (`validate-cases.mjs` lists them), except the handful whose whole point is a file a player must tolerate although the validator rejects it. Those carry `validator.errors` in their `case.json` listing the exact error codes, and the script checks the validator reports those and nothing else, so the suite pins the validator's verdicts as well:

- `walk-dangling-edge-ends-with-error` (`connection/dangling`), `walk-start-missing-falls-back-to-first` (`module/no-start`), `walk-start-several-first-flagged-wins` (`module/multiple-starts`): reader tolerance for files the writer should never have produced (G32, G33).
- `evolution-unknown-node-type-follows-connection` and `evolution-namespaced-extension-type` (`node/unknown-type`): spec rules 5.2 and 5.3. Note that the validator rejects a namespaced `x-` type outright, while rule 5.3 makes it legal; that is a validator gap worth closing.
- `variables-actions-must-ignore` (`action/bad-operator`, `action/unknown-variable`, `action/computed-target`) and `variables-computed-unknown-identifier-is-zero` (`variable/formula-unknown-ref`): must-ignore and the formula's degrade-to-zero rule (5.1, G27, G31).
- `variables-defaults-per-type` and `variables-initial-value-coerced-to-type` (`variable/initial-mismatch`): the validator requires a typed `initialValue` on number and boolean variables, while G27 tells a player what to do when it is absent or mistyped. The spec should say which of the two is right.

## 8. Adding a case

One decision per case, the smallest module that shows it, and an `expect` that would fail if the decision were made the other way. Name the folder after the decision, not the feature. Fill in `spec` and `gaps`. Run all three scripts before committing; the reference must pass, the validator's verdict must match, and if the tiny player can play the case it must agree too. If the reference player disagrees with a decision written in SPEC-GAPS, the engine is what gets fixed, with a unit test in `player/test/`.
