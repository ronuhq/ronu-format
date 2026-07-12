# The `.ronu` File Format — Specification (v0.9 DRAFT)

**Status:** DRAFT — stabilising toward 1.0. The skeleton (§2–§6) is expected to freeze essentially as-is; catalogue entries tagged `provisional` (§7) may still change shape.
**Schema baseline:** the RonuNest platform build of 12 July 2026. The catalogue documents the module content schema as of that build; catalogue entries evolve, the skeleton does not.
**Companions in this repository:** [`validator/`](../validator) (the reference validator — the executable arbiter of a valid `module.json`) and [`samples/`](../samples) (real exported modules to test against).

---

## 0. Design in one paragraph

A `.ronu` file is a **portable, self-contained learning experience**: a branching simulation you can email, put on a USB stick, or send over WhatsApp, and play offline with no account. The format is split into two layers with different stability promises: a tiny **skeleton** (container, envelope, graph shape, evolution rules) that freezes at v1.0 and never changes meaning, and a **node catalogue** (what each node type's config means) that grows freely over time under the skeleton's evolution rules. Players tolerate what they don't understand; extensions are namespaced so anyone can add node types without permission.

## 1. The two-layer stability model (normative)

| Layer | What's in it | Promise |
|---|---|---|
| **Skeleton** (§2–§6) | Container, envelope, graph shape, variables, evolution rules, extension mechanism | Frozen at v1.0. Fields may be *added*; existing fields never change meaning, are never renamed, never removed. |
| **Catalogue** (§7) | Each node type's config profile, tagged `stable` or `provisional` | Grows freely. `stable` entries follow the skeleton promise; `provisional` entries may still change shape and are excluded from conformance claims. |

The version number in the envelope (`formatVersion`) versions the **skeleton**. Catalogue growth does not bump it.

## 2. Container

A `.ronu` file is a **ZIP archive** (like `.docx`/`.epub`) containing:

```
module.ronu (zip)
├── manifest.json     — envelope: identity, versions, integrity (REQUIRED)
├── module.json       — the experience: nodes, variables, settings (REQUIRED)
└── assets/           — bundled media, flat, prefixed names (OPTIONAL)
    ├── 01-intro.jpg
    └── 02-scene.mp4
```

- `manifest.json` and `module.json` are UTF-8 JSON.
- A JSON-only interchange form (just `module.json`, no zip) is legal for tooling/tests, but a conforming *exporter* always emits the zip so media travels with the file — the whole point is USB/WhatsApp shareability.

## 3. Envelope — `manifest.json`

```json
{
  "format": "ronu",
  "formatVersion": "0.9",
  "module": {
    "familyId": "efc6b26a-e7f1-4c91-ba2f-0861fff4334b",
    "versionId": "…uuid…",
    "versionNumber": 6,
    "title": "Restaurant Floor — Reading the Room",
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

- **`familyId` is the permanent identity** of the learning experience: it survives republishing and versioning (all versions of one module share it, while `versionId`/`versionNumber` identify the specific cut). Records keyed by `familyId` — completions, certificates, xAPI statements — stay attached to the experience across revisions.
- **`activityIri`** is the stable xAPI activity identifier, derived from the family: `{origin}/xapi/modules/{familyId}` for the module and `{activityIri}/nodes/{nodeId}` for a node within it. Any player emitting learning records about a .ronu file should use these IRIs so records from different players aggregate instead of fragmenting.
- `formatVersion` is semver-ish: readers MUST accept any file whose major version they support (see §6).
- Everything except `format`, `formatVersion`, `module.familyId`, and `module.title` is optional.

## 4. The experience — `module.json` (the skeleton part)

Top level:

```json
{ "nodes": [ … ], "variables": [ … ], "settings": { … } }
```

**Node shape** — every node is:

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

- `id` — unique within the file; stable within a module version. Node sub-activity IRIs hang off it.
- `type` — a catalogue type (§7) or a namespaced extension type (§5).
- `connection` — the default next node. Branching types carry additional edges inside `config` (per-choice `connection`, hotspot `targetNodeId`, condition `criteriaSets[].targetNodeId`, timer `onExpire.targetNodeId`).
- `position`/`color` — canvas metadata for editors; players MUST ignore them. Kept in the format so a file re-opens in an editor exactly as authored.
- `config` — the type-specific profile (§7). Exactly one node has `config.isStart: true`.

**Variables** — the logic layer that makes this a simulation format rather than a slideshow format:

```json
{
  "id": "var-1", "name": "score", "type": "number", "initialValue": 0,
  "visible": true, "computed": false, "formula": null, "scope": "module"
}
```

`type` ∈ `number | boolean | text`. `computed` variables derive from a `formula` (arithmetic over non-computed variable names). `scope` ∈ `module` (per-session, default) | `learner` (durable across modules — a platform feature; an offline player treats it as module-scoped).

**Settings** — module-level globals: `settings.timer` (whole-module timer, `TimerConfig`) and `settings.completion` (the pass/fail rule — mode `variable` | `reachedNode` | `nodeScore`, operator, threshold, certificate flags). Completion rules are structural (they define what the experience *means*), so they belong in the file; certificate *issuance* is a platform behaviour layered on top.

**What is deliberately NOT in the file:** creator branding/theming, tenancy, pricing/access control, analytics, learner records. The format describes structure and content, not rendering or platform services.

## 5. Evolution rules (normative — this is what makes the format future-proof)

1. **Must-ignore.** A reader encountering an unrecognised JSON field MUST ignore it and continue. Writers MUST NOT change the meaning of existing fields — evolution is additive.
2. **Unknown node type.** A player encountering a node whose `type` it does not implement MUST NOT abort. It presents a neutral fallback (at minimum the node's `title` and a "this step needs a newer player" affordance) and follows the node's `connection` onward. Authors of exotic modules should keep critical routing out of nodes their audience's players may not support.
3. **Namespaced extensions.** Third-party node types use a `prefix:name` type (e.g. `"x-mubs:chemistry-lab"`). The bare (unprefixed) namespace is reserved for this spec's catalogue. Extension configs live entirely inside `config`. An extension that proves broadly useful can graduate into the catalogue with a `stable`/`provisional` tag; graduation never breaks the prefixed form.
4. **Legacy tolerance, canonical output.** Readers MUST accept the documented legacy forms (§8); writers MUST emit only canonical forms. This is how the format sheds warts without breaking old files.

## 6. Versioning & conformance

- `formatVersion` `MAJOR.MINOR`: MINOR bumps are always additive (rule 5.1 makes them safe); a MAJOR bump is a breaking change and is expected to be rare-to-never.
- **Minimal player** (conformance level 1): implements the skeleton + the `stable` catalogue types, rules 5.1–5.3, and plays fully offline from the zip. May treat `code`, `conversation`, and 3-D scene kinds as unknown (rule 5.2).
- **Full player** (level 2): additionally implements the `provisional` types it declares, the code-node sandbox, and AI-backed conversation (which requires connectivity — a full player degrades to the fallback offline).
- The [reference validator](../validator) is the executable arbiter of "valid module.json".

## 7. The node catalogue (as of the 12 Jul 2026 baseline)

Thirteen types. Tags: **stable** = shape settled, follows the skeleton promise from v1.0; **provisional** = actively evolving, expect additions/reshaping.

| Type | Tag | Config essentials |
|---|---|---|
| `message` | **stable** | `content` (rich text/HTML), `files[]` (attachments — bundled under `assets/`), `showContinueButton`, `advanceOnAnswer` |
| `video` | **stable** | `videoUrl` (bundled), `thumbnailUrl`, `subtitlesUrl`, `videoControls{autoplay, showPlayPause, showVolume, showSubtitles, allowSeeking}` |
| `choice` | **stable** | `question`, `choices[]{id, text, connection, actions[], condition}` — the core branching primitive |
| `textInput` | **stable** | `question`; free-text answer recorded to the session |
| `multipleChoice` | **stable** | `question`, `choices[]` (no per-choice routing), `allowMultiple`, `advanceOnAnswer` |
| `ranking` | **stable** | `question`, `rankingItems[]` |
| `matching` | **stable** | `matchingLeftItems[]{id, text, correctRightId, actions[]}`, `matchingRightItems[]{id, text}`, `matchingGraded` |
| `rating` | **stable** | `ratingVariableId`, `ratingMin/Max`, `ratingStyle` (`stars|numbers|emoji`), low/high labels |
| `condition` | **stable** (canonical form) | `criteria{criteriaSets[]{conditions[]{field, operator, value}, targetNodeId, pathLabel}, defaultTargetNodeId}` — see §8 for the legacy stringified form |
| `note` | **stable** | Canvas-only annotation. Players MUST skip it entirely; it is never part of the flow. |
| `scene` | **partially stable** | Stable: `environment{kind: photo360|photo2d, source}`, `hotspots[]{position, label, required, hidden, reveal, targetNodeId, variableActions, conversation}`, `completion` (`free|allRequired`), `hotspotSequence` (`free|ordered`), `discoveryRadius`, `missActions`. **Provisional:** `kind: splat|embed3d` (renderers still landing). |
| `conversation` | **provisional** | `persona`, `firstMessage`, `objective`, `maxTurns`, `scoreVariableId`, `visual{background, characterName, voice, states[]}`. Requires an AI backend — minimal players fall back per rule 5.2. Voice/visual surface still moving. |
| `code` | **provisional** | `source` (a sandboxed `run({ctx, ui, emit})` body), `assetPack`, `assets3d{}`, `room{}`. The 3-D surface is under active development (Jul 2026). Executing `source` requires a sandbox; players that don't ship one use the fallback. **Security note:** a player MUST NOT execute `source` outside a sandbox — .ronu files arrive from untrusted channels by design. |

**Shared sub-schemas** (stable, used across types): `VariableAction{variableId, operator, value}` with operators `set|increment|decrement|multiply|divide|set_true|set_false|toggle`; `NodeTrigger{type: onNodeEnter|onNodeExit|onTimerElapsed|onVideoComplete|onVideoTimestamp, actions[], config}`; `TimerConfig{mode: countdown|countup, seconds, visible, label, warnAtSeconds, sound, onExpire{behavior: none|advance|route|end, targetNodeId, actions[]}, recordVariableId}`; text placeholders `{variableName}` substituted at play time.

The vendored [validator sources](../validator/src) carry the full TypeScript definitions for every profile above.

## 8. Canonical form vs. accepted legacy (readers accept both; writers emit canonical only)

| Concern | Canonical (what exporters write) | Legacy (what readers must also accept) |
|---|---|---|
| Condition config | `config.criteria` as a **parsed object** `{criteriaSets, defaultTargetNodeId, defaultPathLabel}` | `config.choices` as a **JSON-encoded string** of the same object |
| Node types | `choice`, `condition` | `router` → `choice`, `decisionPath` → `condition` |
| Media references | Relative bundle paths (`assets/<name>`) | Platform storage refs and absolute URLs — playable only online |
| Message attachments | `files[].path` → bundle path | `files[].data` base64 data-URLs — readers may play them; exporters convert to bundled assets |

Export rewrites every media reference in `module.json` to its bundle path and records it in the manifest; import re-uploads assets and rewrites back to platform refs.

## 9. What the spec does NOT define

Learner records and reporting (that's xAPI's job — the envelope carries the activity IRIs it needs), DRM (deliberately none — access control is a platform concern), rendering/theming, the AI backends behind `conversation`, and platform services (groups, certificates, analytics). Open format, closed platform.

## 10. Appendix: guidance for editor/platform implementers

Look-and-feel is not the format's business: fonts, animations, transitions, layouts are all player-side, and players are *supposed* to compete on feel. Only three kinds of product change touch the format, in ascending order of care:

1. **New authoring options that must travel with the file** (a theme, background audio, a layout variant) → **new optional config fields**: purely additive, covered by must-ignore (rule 5.1).
2. **New interaction patterns** → a **new node type**: additive catalogue entry, `provisional` at first.
3. **Reshaping existing fields** — the only dangerous one. That is a *meaning change*, forbidden for `stable` entries — it must go through the canonical/legacy mechanism (§5.4/§8).

The one-question discipline: **"is this a player behaviour, or an author's choice that must survive export?"** Player behaviour → not in the file. Author choice → additive optional config field.

## 11. Road to v1.0

1. Freeze the **skeleton** (§2–§6) — nothing in it is contentious.
2. Let the catalogue's `provisional` entries (code/3-D, conversation visuals) settle; re-tag as `stable` when their configs stop moving.
3. Cut v1.0 = frozen skeleton + the then-stable catalogue; publish the validator to npm.
4. The **reference player** — an offline app that plays any conformant `.ronu` with no account — is the format's most-wanted missing piece, and an intentionally open invitation: see [CONTRIBUTING](../CONTRIBUTING.md).
