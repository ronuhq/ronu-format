# Contributing to the `.ronu` format

Thanks for your interest — the format gets better with more implementers. Here's how the project is governed and how to take part.

## The core / extensions split

- **The core** is the spec's skeleton plus the node catalogue (`spec/ronu-spec.md` §1–§8). Changes to it are conservative by design: the skeleton's promise is that meaning never changes.
- **Extensions are yours.** Anyone may create node types under their own namespace (`x-yourname:type`, spec §5.3) without asking. Publish them wherever you like; conformant players fall back gracefully on types they don't know.

## How change happens

| You want to… | Do this |
|---|---|
| Build a player, editor, or converter | Just build it — no permission needed. Open an issue to tell us; we'll link it. |
| Add a node type for your own domain | Use a namespaced extension (`x-…:`). No process. |
| Propose an extension for **graduation into the catalogue** | Open an issue titled `graduation: <type>` with the config schema, at least one real implementation, and sample files. Graduated types enter as `provisional`. |
| Move a `provisional` type to `stable` | Open an issue with evidence the shape has stopped moving (implementations, files in the wild). `stable` is a one-way door — once tagged, the shape's meaning is frozen. |
| Fix the spec text, validator, or samples | Pull request. For the validator, keep the crate dependency-light, and regenerate the schema if you touch the types. |
| Change the **skeleton** | Expect a very high bar: skeleton changes must be additive (spec §5.1) and are batched into MINOR releases. Breaking changes (MAJOR) are intended never to happen. |

## Ground rules for spec changes

1. **Additive only.** New optional fields, new node types — never renaming, removing, or changing the meaning of anything `stable`.
2. **Legacy in, canonical out** (spec §5.4). If a wart must be fixed, readers accept the old form forever; writers emit the new form.
3. **Samples accompany schema.** A change to the catalogue ships with a sample file exercising it.
4. **The validator is the arbiter.** If the spec text and the validator disagree, that's a bug — file it.

## Practical notes

- The reference implementation is a Rust crate ([`rust/`](rust)): the types, the validator, and the JSON Schema generator. `cargo run --manifest-path rust/Cargo.toml --bin ronu -- validate <module.json>` runs the validator; `cargo test` checks it. The JSON Schema is **generated** from the same types (`cargo run --bin gen-schema`) — never hand-edit `schema/ronu-module.schema.json`.
- The originating implementation (export, import, authoring) lives in the RonuNest platform; this repository is the format's public home and the platform tracks it.
- Be excellent to each other: see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
