# Rust rewrite — status & handoff

Working notes for the `.ronu` format's move to a **Rust single source of
truth**, so this can be picked up on any machine. Started 22 Jul 2026.

## Why this exists (the pivot)

Following a review by Cameron (offline/dev-advocacy advisor; cites his
`agentclientprotocol/agent-client-protocol` as the model), the format is moving
to:

1. **Rust as the single source of truth.** Types + validation live in Rust; the
   JSON Schema and (later) TS/Python bindings are *generated* from those types,
   so schema, validator, and bindings can never disagree. The platform
   (RonuNest, TypeScript) will consume generated bindings instead of the
   hand-written TS validator.
2. **Trunk-based / unversioned.** No `v0.9` — the commit hash is the version,
   all changes assumed breaking, until a first-party tool ecosystem settles.
   (Reverses the earlier "publish v0.9" decision.)
3. **README rewrite** — the current one reads AI-generated; to be re-drafted
   plain and voiced by Hameed. (Not started.)

## What's done ✅  (`rust/` crate — compiles, 12 tests green)

| Piece | File |
|---|---|
| Skeleton types (serde + schemars) | `rust/src/types.rs` |
| Formula parser + evaluator | `rust/src/formula.rs` |
| Semantic validator (full port) | `rust/src/validate.rs` |
| Library entry | `rust/src/lib.rs` |
| CLI `ronu validate <file…>` | `rust/src/bin/ronu.rs` |
| Schema generator | `rust/src/bin/gen_schema.rs` |
| Differential + negative tests | `rust/tests/samples.rs` |
| Generated schema (artifact) | `schema/ronu-module.schema.generated.json` |

Design choices baked in:
- **Liberal reader** (spec's must-ignore rule): almost every field is optional
  and unknown fields are captured in a flattened `extra` map, so a file from a
  newer writer still parses. `NodeConfig` therefore generates with
  `additionalProperties: true` automatically — the "catalogue grows freely"
  rule, for free.
- `type` / `operator`-style fields stay **strings**, not enums, so an unknown
  value becomes a *validation issue* (`node/unknown-type`, …) rather than a
  parse failure.

## Verification ✅

- `cargo test` → 12 pass: 3 formula unit tests + 9 in `tests/samples.rs`.
- **Differential**: the Rust validator reproduces the reference TS validator's
  exact issue codes on all four samples — including the legacy sample
  (`router`/`decisionPath` types + stringified condition config →
  `condition/no-default` + `node/unreachable`). This is the guarantee that the
  port didn't change behaviour.
- The **generated** schema accepts all four samples via `ajv` (`format: double`
  warnings are harmless schemars hints on `f64`).

## How to run

```bash
cd rust
cargo test                                   # unit + differential
cargo run --bin ronu -- validate ../samples/*/module.json
cargo run --bin gen-schema > ../schema/ronu-module.schema.generated.json
```

## What remains 🔜  (rough order)

1. **README** — plain, de-slopped draft for Hameed to voice.
2. **Cutover** — once parity is trusted:
   - delete the TS `validator/` and the hand-written `schema/ronu-module.schema.json`;
   - point CI (`.github/workflows/ci.yml`) at `cargo test` + `cargo run --bin gen-schema` (assert the committed schema is up to date);
   - move `rust/` to the repo's canonical spot (or make it the root crate).
3. **Bindings** — generate TS types the *platform* consumes (wasm-bindgen or
   `ts-rs`), so RonuNest drops its hand-written TS validator. Python (`pyo3`)
   later.
4. **Strip version strings** repo-wide for trunk-based (spec header, schema
   `$id`, package names, CHANGELOG → "Unreleased").
5. **Update the dossier** (`docs/ronu-format-dossier.md`, platform repo
   `hameed-claude-dev`) to Rust-canonical + trunk-based.

## Open decisions

- **Schema draft**: schemars emits **draft-07**; the old hand-written schema was
  **2020-12**. Kept draft-07 (widest tooling) unless there's a reason to switch.
- **Git identity**: this branch is committed as `Hameed Adigun
  <hameed@ronucreative.com>`. The three pre-existing commits on `main` are still
  authored `Your Name <your.email@example.com>` — Cameron flagged this; the
  planned cleanup is a history reset + force-push with the final chosen public
  identity (and signing, if wanted). Not done here to avoid a destructive push
  without sign-off.

## Repos

- **Public** (this): `github.com/ronuhq/ronu-format` — Apache-2.0, owned by
  RonuCreative Ltd. This WIP is on branch **`rust-rewrite`**.
- **Platform**: RonuNest, branch `hameed-claude-dev` — has the dossier, the spec,
  the TS `packages/ronu-validator`, and `docs/ronu-samples`.
