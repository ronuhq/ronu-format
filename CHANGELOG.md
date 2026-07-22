# Changelog

All notable changes to the `.ronu` format and this repository are recorded here. The format follows the versioning rules in the [spec](spec/ronu-spec-v0.9.md) §6: `formatVersion` versions the frozen skeleton; catalogue additions don't bump it.

## Unreleased

- **Reference implementation moved to Rust** ([`rust/`](rust)) — one set of Rust types now drives (de)serialization, semantic validation, and the **generated** JSON Schema, so the three can never disagree. The previous TypeScript validator is retired; TS/Python bindings generated from the Rust are planned.
- **Trunk-based from here** — the commit hash is the version until the tooling ecosystem settles (see the format dossier). The JSON Schema is standardised on draft-07.

## v0.9 — DRAFT (2026-07-12)

First public draft. The skeleton (container, envelope, graph shape, evolution rules) is expected to freeze as v1.0 essentially unchanged; some node types are still marked `provisional`.

- **Spec** — the two-layer stability model, ZIP container, `manifest.json` envelope with the permanent `familyId` and xAPI activity IRIs, the 13-type node catalogue with `stable`/`provisional` tags, the evolution rules (must-ignore, unknown-node fallback, namespaced extensions, legacy-in/canonical-out).
- **Reference validator** — pure TypeScript, zero runtime dependencies, with a CLI.
- **JSON Schema** (draft 2020-12) for `module.json`.
- **Samples** — three interchange-form modules (including a legacy-forms one) plus `hello-ronu`, a real self-contained `.ronu` with a bundled image.

[Unreleased]: the road to v1.0 — freeze the skeleton, settle the `provisional` catalogue entries, publish the validator to npm. See the spec's "Road to v1.0".
