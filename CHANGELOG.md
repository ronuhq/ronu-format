# Changelog

All notable changes to the `.ronu` format and this repository are recorded here. The format is **unversioned** during the current trunk-based phase: the commit hash is the version and any change may break, until a `v1.0` is cut and the [spec](spec/ronu-spec.md) §6 versioning rules take effect. Entries below are dated, not versioned.

## Unreleased

### 2026-09-12: the player semantics are written down (spec §9)

- **Spec §9 "Player semantics"** (new, normative): the walk (start, edges, where the experience ends, dangling edges, legacy type names), variables (defaults, coercion, every action operator with its edge cases, the placeholder grammar and where substitution applies, the formula grammar in full with its six-decimal rounding), conditions (the operator table with canonical and legacy spellings, field resolution including the answer-of-a-node rule, the connector grammar and `join`, the no-match rule), completion and scoring (modes, `scoreAggregate`, the per-type grade table, what "score" means at the end), triggers and timers (every `config` key, defaults, each `onExpire` behaviour, `recordVariableId`), scenes (the angular convention, discovery, hidden hotspots, the beat order, `hotspotSequence` and `completion`, nested interactions, the `abortWhen` evaluation points), per-type notes, media and the HTML allowlist for `message.content`, and container tolerance. The old §9 to §11 are now §10 to §12; §1, §6, §7 and §8 gained cross references. Every entry G1 to G47 of the reference player's gap list now maps to a sentence in the spec.
- **Record-receiver contract** ([`docs/record-receiver.md`](docs/record-receiver.md)): `moduleId` is `manifest.module.versionId` (the exporter never wrote `module.id`), plus `maxTurns`, degraded replies, the rubric on finalize, the assessment envelope, hotspot conversations, what one session is for the once-only rule, the 401 and 413 rows, the refresh response, plain http, the certificate origin, and the no-popup tab route (G48 to G60).
- **[`player/SPEC-GAPS.md`](player/SPEC-GAPS.md)** is now a resolution ledger: each gap names the section that resolves it, with a short "Still open" list.
- **Road to v1.0**: the semantics are written; a conformance suite that exercises §9 outside the reference player is the next gate.

### 2026-09-09: catalogue sync with the platform build of 9 Sep 2026 (commit `5aa3ce4`)

- **Two new node types**, both `provisional`: `procedure` (perform steps in order; a step taken out of turn has its consequence straight away) and `dragToTarget` (put the right thing in the right place; an item with no `targetId` is a distractor). Spec §7.
- **Answering inside a scene**: a hotspot may carry an `interaction` (a nested message, multipleChoice, textInput, matching, ranking, rating, procedure or dragToTarget, answered in the room), and a scene may carry an `abortWhen` early-exit rule. Nested interactions never route. Spec §7.2.
- **Rubrics for AI-graded conversation**: `rubric[]{id, label, weight}` on a conversation node and `criteria[]` on a hotspot character. Spec §7.
- **Code nodes** gained the assessment seam (`hooks`, `hookBindings`, `effects`, `effectRules`, `layout`, `sourceHistory`). Spec §7.1.
- **Validator**: new checks ported from the platform, with identical issue codes: `procedure/no-steps`, `procedure/critical-no-reason`, `dragToTarget/incomplete`, `dragToTarget/orphan-item`, `matching/empty`, `matching/dangling-match`, `ranking/too-few`, `code/no-source`, `scene/abort-*`, `scene/interaction-unanswerable`, `scene/interaction-no-question`, and the pass-mark reachability pass (`threshold/unreachable`, `threshold/tight`). Computed-variable evaluation now rounds to six decimals, as the platform does. `ronu validate --json` prints machine-readable results.
- **Samples**: `barrier-cream-round` (procedure + dragToTarget + rubric) and `margarets-room` (a scene with nested interactions and an early exit). All six samples are differentially tested against the platform validator.
- **Schema** regenerated from the types (the new profiles are now described, not just tolerated).

### Earlier

- **Reference implementation moved to Rust** ([`rust/`](rust)): one set of Rust types now drives (de)serialization, semantic validation, and the **generated** JSON Schema, so the three can never disagree. The previous TypeScript validator is retired; TS/Python bindings generated from the Rust are planned.
- **Trunk-based from here**: the commit hash is the version until the tooling ecosystem settles (see the format dossier). The JSON Schema is standardised on draft-07.

## 2026-07-12: first public draft

First public draft. The skeleton (container, envelope, graph shape, evolution rules) is expected to freeze as `v1.0` essentially unchanged; some node types are still marked `provisional`.

- **Spec**: the two-layer stability model, ZIP container, `manifest.json` envelope with the permanent `familyId` and xAPI activity IRIs, the 13-type node catalogue with `stable`/`provisional` tags, the evolution rules (must-ignore, unknown-node fallback, namespaced extensions, legacy-in/canonical-out).
- **Reference validator**: a CLI + library. (Reimplemented in Rust on 22 Jul; see Unreleased.)
- **JSON Schema** for `module.json`.
- **Samples**: three interchange-form modules (including a legacy-forms one) plus `hello-ronu`, a real self-contained `.ronu` with a bundled image.

The road to `v1.0`: freeze the skeleton, settle the `provisional` catalogue entries, start versioning, publish the crate + bindings. See the spec's "Road to v1.0".
