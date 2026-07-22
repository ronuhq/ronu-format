# Changelog

All notable changes to the `.ronu` format and this repository are recorded here. The format is **unversioned** during the current trunk-based phase — the commit hash is the version and any change may break, until a `v1.0` is cut and the [spec](spec/ronu-spec.md) §6 versioning rules take effect. Entries below are dated, not versioned.

## Unreleased

- **Reference implementation moved to Rust** ([`rust/`](rust)) — one set of Rust types now drives (de)serialization, semantic validation, and the **generated** JSON Schema, so the three can never disagree. The previous TypeScript validator is retired; TS/Python bindings generated from the Rust are planned.
- **Trunk-based from here** — the commit hash is the version until the tooling ecosystem settles (see the format dossier). The JSON Schema is standardised on draft-07.

## 2026-07-12 — first public draft

First public draft. The skeleton (container, envelope, graph shape, evolution rules) is expected to freeze as `v1.0` essentially unchanged; some node types are still marked `provisional`.

- **Spec** — the two-layer stability model, ZIP container, `manifest.json` envelope with the permanent `familyId` and xAPI activity IRIs, the 13-type node catalogue with `stable`/`provisional` tags, the evolution rules (must-ignore, unknown-node fallback, namespaced extensions, legacy-in/canonical-out).
- **Reference validator** — a CLI + library. (Reimplemented in Rust on 22 Jul; see Unreleased.)
- **JSON Schema** for `module.json`.
- **Samples** — three interchange-form modules (including a legacy-forms one) plus `hello-ronu`, a real self-contained `.ronu` with a bundled image.

The road to `v1.0` — freeze the skeleton, settle the `provisional` catalogue entries, start versioning, publish the crate + bindings. See the spec's "Road to v1.0".
