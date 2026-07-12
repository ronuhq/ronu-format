# The `.ronu` format

[![CI](https://github.com/ronuhq/ronu-format/actions/workflows/ci.yml/badge.svg)](https://github.com/ronuhq/ronu-format/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**An open file format for interactive, branching learning experiences.**

A `.ronu` file is a complete simulation — the scenario graph, the choices, the scoring logic, the media — in a single portable zip you can email, put on a USB stick, or send over WhatsApp. No account, no platform lock-in: the format is open, and anyone can build tools that read or write it.

> **Status: v0.9 DRAFT.** The format's skeleton is stable and expected to freeze as v1.0 essentially unchanged; some node types are still marked provisional. Real `.ronu` files are being produced and consumed today by [RonuNest](https://ronunest.com), where the format originates.

## Why

Most learning content is locked inside the platform that made it. SCORM solved portability for *slideshow-era* content two decades ago; nothing equivalent exists for **simulation-style** learning — branching scenarios, variables and scoring, immersive scenes, AI-driven conversations. `.ronu` is that missing format: expressive enough for real simulations, simple enough that a student can write a player for it.

It is also built for places the always-online assumption fails: the file carries its own media, so experiences can travel peer-to-peer and play fully offline.

## What's in this repository

| Path | What it is |
|---|---|
| [`spec/ronu-spec-v0.9.md`](spec/ronu-spec-v0.9.md) | The specification: container, envelope, node catalogue, evolution rules |
| [`schema/ronu-module.schema.json`](schema/ronu-module.schema.json) | JSON Schema (draft 2020-12) for `module.json` — validate or codegen in any language |
| [`validator/`](validator) | The reference validator — pure TypeScript, zero dependencies, CLI included |
| [`samples/`](samples) | Real modules, including [`hello-ronu/`](samples/hello-ronu) — an **actual `.ronu` file** with a bundled image you can unzip and inspect |

## Try it in 60 seconds

```bash
git clone https://github.com/ronuhq/ronu-format
cd ronu-format

# 1. Look inside a real .ronu file — it's just a zip
unzip -l samples/hello-ronu/hello.ronu

# 2. Validate every sample module against the reference validator
npx -y tsx validator/cli.ts samples/*/module.json
```

You should see the zip contain `manifest.json`, `module.json`, and `assets/01-cover.png`, and every sample validate. Now break one — delete a node a connection points at — and run it again.

Prefer a JSON Schema? [`schema/ronu-module.schema.json`](schema/ronu-module.schema.json) validates the same files in any language — e.g. `npx -y ajv-cli@5 validate --spec=draft2020 --strict=false -s schema/ronu-module.schema.json -d "samples/*/module.json"`. (The schema checks *shape*; the reference validator additionally checks *semantics* — a single start node, no dangling connections, reachability.)

## The design in three ideas

1. **Two layers, two promises.** A tiny frozen *skeleton* (zip container, manifest, node/variable graph shape, evolution rules) that will never change meaning — and a *node catalogue* that grows freely under it. Players built today keep working as the format grows.
2. **Liberal readers, canonical writers.** Unknown fields are ignored; unknown node types render a graceful fallback and the flow continues. Old files never break; new features never strand old players.
3. **Extensions without permission.** Namespaced node types (`x-yourlab:experiment`) let anyone extend the format for their own domain. Good extensions can graduate into the core.

## What's most wanted

**A reference player.** An offline-first app (web or native) that opens any conformant `.ronu` and plays it — no account, no server. The spec's conformance level 1 (§6) defines the minimum viable player, and the samples give you files to test against. If you're a student or a lab looking for a project with real users waiting: this is it. Open an issue and say hello — see [CONTRIBUTING](CONTRIBUTING.md).

## Licence

[Apache-2.0](LICENSE). The format is open for anyone to implement, commercially or otherwise.
