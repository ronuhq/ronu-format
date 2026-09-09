# The `.ronu` format

[![CI](https://github.com/ronuhq/ronu-format/actions/workflows/ci.yml/badge.svg)](https://github.com/ronuhq/ronu-format/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

An open file format for interactive, branching learning experiences.

A `.ronu` file holds a whole simulation in one zip: the scenario graph, the choices, the scoring logic, and the media. You can email it, drop it on a USB stick, or send it over WhatsApp, and it plays offline with no account. The format is open, so anyone can build tools that read or write it.

> **Status: draft, unversioned.** It lives on trunk, so the commit hash is the version and anything can change until a `v1.0` is cut. The skeleton (spec §2 to §6) should freeze at `v1.0` roughly as it stands, and a few node types are still marked provisional. Real `.ronu` files are made and played today by [RonuNest](https://ronunest.com), where the format comes from.

## Why it exists

Most learning content is stuck inside the tool that made it. SCORM made slideshow-style content portable twenty years ago, but nothing does the same for simulation-style learning: branching scenarios, variables and scoring, explorable scenes, AI-driven conversation. `.ronu` is meant to fill that gap. It's small enough that one person can write a player for it, and it carries its own media so it works where the network doesn't.

## What's in this repository

| Path | What it is |
|---|---|
| [`spec/ronu-spec.md`](spec/ronu-spec.md) | The specification: container, envelope, node catalogue, evolution rules. |
| [`rust/`](rust) | The reference implementation in Rust: types, validator, schema generator. This is the source of truth. |
| [`schema/ronu-module.schema.json`](schema/ronu-module.schema.json) | JSON Schema for `module.json`, generated from the Rust types. Validate or generate types in any language. |
| [`bindings/wasm/`](bindings/wasm) | The validator compiled to WebAssembly, so JavaScript and TypeScript can run it directly. |
| [`samples/`](samples) | Real modules, including [`hello-ronu/`](samples/hello-ronu): an actual `.ronu` file with a bundled image you can unzip and read. |

## Look inside a file

A `.ronu` file is a zip. Open one, then validate the sample modules. You'll need [Rust](https://rustup.rs).

```bash
git clone https://github.com/ronuhq/ronu-format
cd ronu-format

# A .ronu is a zip, so look inside
unzip -l samples/hello-ronu/hello.ronu

# Validate the sample modules
cargo run --manifest-path rust/Cargo.toml --bin ronu -- validate samples/*/module.json
```

The zip holds `manifest.json`, `module.json`, and `assets/01-cover.png`, and every sample reports as valid. Delete a node that a connection points to, run it again, and you'll see it fail.

For a shape check in any language, use the JSON Schema:

```bash
npx -y ajv-cli@5 validate --spec=draft7 --strict=false \
  -s schema/ronu-module.schema.json -d "samples/*/module.json"
```

The schema checks structure. The validator also checks meaning: one start node, no connection pointing at a node that isn't there, every node reachable. Run both for a real conformance check.

## Design

The format is in two layers with different promises.

The **skeleton** is the zip container, the manifest, the node-and-variable graph, and the rules for how the format changes. It's meant to freeze at `v1.0` and keep its meaning after that.

The **node catalogue** is what each node type's config means. It keeps growing: new node types get added, and the ones already there don't change under you.

Three rules keep old files and old players working as it grows.

- A reader ignores fields it doesn't recognise.
- A player that meets a node type it doesn't know shows a plain fallback and carries on instead of failing.
- Anyone can add node types under their own namespace (`x-yourlab:experiment`) without asking, and useful ones can move into the core later.

The [spec](spec/ronu-spec.md) has the rest.

## Play a file

[`player/`](player) is the reference player: plain JavaScript, no build step, installable as an offline PWA. Serve this repository with any static server and open `player/index.html`, then drop a `.ronu` on it or press "Try a sample". It implements conformance level 1 (the skeleton and every `stable` node type) plus the provisional `procedure` and `dragToTarget`, and it was written from the spec rather than from RonuNest's code. What the spec failed to tell it is recorded in [`player/SPEC-GAPS.md`](player/SPEC-GAPS.md); that file is how the spec gets better.

## Write your own

[Build a player in an afternoon](docs/build-a-player.md) walks the format in the order an implementer meets it, and the 200-line terminal player it describes is checked in at [`docs/examples/tiny-player.mjs`](docs/examples/tiny-player.mjs). CI runs it over every sample.

- **Rust**: the [`ronu`](rust) crate gives you the types, the validator, and the schema generator.
- **JavaScript or TypeScript**: [`bindings/wasm`](bindings/wasm) compiles the same validator to WebAssembly, so you get the real rules in a browser or Node without rewriting them.
- **Any language**: the generated [JSON Schema](schema) covers structure.

## Implementations

| What | Where | Notes |
|---|---|---|
| Reference player (web, offline PWA) | [`player/`](player) | level 1 + procedure, dragToTarget |
| Tutorial player (terminal) | [`docs/examples/tiny-player.mjs`](docs/examples/tiny-player.mjs) | skeleton + message, choice, condition |
| Authoring, export, import | [RonuNest](https://ronunest.com) | the originating implementation |

Built something? Open an issue and it gets a row here.

## Teaching with it

[`docs/for-universities.md`](docs/for-universities.md) sizes student projects from an afternoon to a semester and says what we commit to in return.

## Help wanted

A conformance suite: a language-neutral set of files plus expected outcomes that any player can run. The samples and the reference player's tests are the seed. See [CONTRIBUTING](CONTRIBUTING.md).

## Licence

[Apache-2.0](LICENSE). Implement it freely, commercially or not.
