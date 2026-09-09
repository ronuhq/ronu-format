# Rust rewrite: status & handoff

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
2. **Trunk-based / unversioned.** No `v0.9`: the commit hash is the version,
   all changes assumed breaking, until a first-party tool ecosystem settles.
   (Reverses the earlier "publish v0.9" decision.)
3. **README rewrite**: the current one reads AI-generated; to be re-drafted
   plain and voiced by Hameed. (Not started.)

## What's done ✅  (`rust/` crate: compiles, 12 tests green)

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
  `additionalProperties: true` automatically: the "catalogue grows freely"
  rule, for free.
- `type` / `operator`-style fields stay **strings**, not enums, so an unknown
  value becomes a *validation issue* (`node/unknown-type`, …) rather than a
  parse failure.

## Verification ✅

- `cargo test` → 12 pass: 3 formula unit tests + 9 in `tests/samples.rs`.
- **Differential**: the Rust validator reproduces the reference TS validator's
  exact issue codes on all four samples, including the legacy sample
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

## Cutover ✅ (done 22 Jul 2026)

The Rust crate is now the reference. TS `validator/` retired; the hand-written
schema is replaced by the **generated** `schema/ronu-module.schema.json`
(draft-07, carries `$id` + title); CI (`.github/workflows/ci.yml`) runs `cargo
test`, asserts the committed schema matches `gen-schema` output (fails if a type
change wasn't regenerated), and validates every sample via the Rust CLI + ajv.
All the docs (README, CONTRIBUTING, SECURITY, spec, samples/schema READMEs) now
point at `rust/` instead of the old validator. `rust/` stays a subdir (room for
`typescript/`, `python/` binding dirs later).

## Bindings: wasm validator ✅ (22 Jul), integration pending

`bindings/wasm/` (crate `ronu-wasm`, wasm-bindgen) exposes
`validate(moduleJsonString) → { valid, errors, warnings }`, the actual Rust
validator, in JS, in the platform's exact result shape. Built with `wasm-pack
build bindings/wasm --target web|nodejs`; verified in Node against the samples +
the oracle (matches). CI builds it to the wasm target. `pkg/` is git-ignored
(rebuild to consume). To make this pay off, the core got `Serialize` on
`Issue`/`ValidationResult` (camelCase, `nodeId` omitted when absent).

## Sync with the platform, 9 Sep 2026

The platform validator had moved on since July (two node types, nested scene
interactions, the pass-mark reachability pass, rubrics). Ported in full and
re-verified differentially against the platform's `validateModuleContent` at
commit `5aa3ce4`: all six samples plus ~70 negative fixtures produce identical
issue codes. Method: a scratch `tsx` wrapper prints the oracle's result as JSON,
`ronu validate --json` prints ours, a script diffs the sorted `code@nodeId`
pairs. Re-run that whenever the platform validator changes.

The port found one platform bug: the threshold pass called `parseFormula`
unguarded, so a pass rule on a computed variable whose formula does not parse
made the platform validator throw. The platform was fixed the same day (it now
reports `variable/formula-invalid` and gives the variable no ceiling, exactly
as this crate does), so there is no known divergence.

## What remains 🔜  (rough order)

1. **Platform integration**: RonuNest imports `@ronu/wasm` and drops its
   hand-written `packages/ronu-validator`. This is in the *platform* repo and
   needs: Vite wasm config, async `init()` at the validate call sites (wasm
   loads async), swapping `validateModuleContent`, the platform vitest suite,
   and a browser check. Deliberately its own pass; don't do it in a hurry on
   the live product.
2. **Binding niceties**: type the wasm return as `ValidationResult` (wasm-pack
   emits `any`); generate TS types from the schema (`json-schema-to-typescript`)
   for the module-content shape; Python via `pyo3` later.
3. **README**: a plain, de-slopped rewrite is now in place (rule-of-three
   headers, "in 60 seconds", the pitch closer all gone; surfaces the wasm
   binding). It's still an AI-written *scaffold*; Hameed's own voice pass (or
   `/hameed-voice`) is the real finish, per Cameron's point that the surest fix
   for "sounds like AI" is a human's hand.

Done 22 Jul: **version strings stripped**: spec renamed `spec/ronu-spec.md`
and reframed unversioned/trunk-based; README / CHANGELOG / CONTRIBUTING /
samples updated. The envelope `formatVersion` field itself is left as-is (files
still carry `"0.9"`); whether the format keeps a `formatVersion` field, and its
value during the trunk phase, is an **open design question for the `v1.0` cut**
(flag for Cameron). **Dossier updated** (platform repo) to Rust-canonical +
trunk-based.

## Open decisions

- **Schema draft**: schemars emits **draft-07**; the old hand-written schema was
  **2020-12**. Kept draft-07 (widest tooling) unless there's a reason to switch.
- **Git identity**: DONE (22 Jul 2026). All commits on `main` and
  `rust-rewrite` were rewritten to `Hcatel
  <18502309+Hcatel@users.noreply.github.com>` (GitHub noreply, which links to the
  profile, no inbox to spam) and force-pushed. Set the same locally on any new
  machine: `git config user.name Hcatel && git config user.email
  18502309+Hcatel@users.noreply.github.com`. **Signed commits deferred**:
  optional; needs a GPG/SSH key generated per machine and registered with
  GitHub for the green "Verified" badge.

## Repos

- **Public** (this): `github.com/ronuhq/ronu-format`, Apache-2.0, owned by
  RonuCreative Ltd. This WIP is on branch **`rust-rewrite`**.
- **Platform**: RonuNest, branch `hameed-claude-dev`, has the dossier, the spec,
  the TS `packages/ronu-validator`, and `docs/ronu-samples`.
