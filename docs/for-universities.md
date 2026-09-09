# `.ronu` for universities: student projects that ship

`.ronu` is a small, open, well-specified file format with a real reference
implementation, real sample files, and a real product producing files every
day. That makes it an unusually good base for computer science and software
engineering coursework: the problem is concrete, the spec fits in one
reading, a first result takes an afternoon, and the work is useful to people
outside the classroom the moment it lands.

This page is for lecturers and course leads. It lists project shapes we have
seen work, sized from an afternoon to a semester, and what we commit to in
return.

## Why this is a good project base

- **A spec you can read in one sitting.** [`spec/ronu-spec.md`](../spec/ronu-spec.md) is the whole contract. There is no hidden behaviour.
- **Two ways to check your work.** The [JSON Schema](../schema/ronu-module.schema.json) checks structure in any language; the [Rust validator](../rust) (also [compiled to WebAssembly](../bindings/wasm)) checks meaning.
- **Real files.** [`samples/`](../samples) holds real modules exported from RonuNest, including an actual `.ronu` zip with bundled media.
- **A reference player to compare against.** [`player/`](../player) is a plain-JavaScript player written from the spec. Students can read it, run it, or ignore it and build their own.
- **Evolution rules that make extensions safe.** Spec §5: unknown fields are ignored, unknown node types fall back gracefully, and anyone can add node types under their own `x-` namespace without asking. A student extension cannot break anyone else's player.
- **Offline by design.** A `.ronu` file carries its own media and plays without a network. Projects that target cheap phones, USB sticks, or classrooms with no connectivity are first-class, not workarounds.

## Project shapes

### An afternoon: read a file

Good as a lab exercise or a first-week warm-up.

- Unzip a `.ronu`, parse `module.json`, print the node graph (ids, types, connections) as a tree or a Graphviz `dot` file.
- Validate a sample against the JSON Schema in the language of the course.
- Count reachable nodes from the start node; find nodes nothing connects to.

### A week: a player

The core exercise. Conformance level 1 in spec §6: skeleton, the `stable`
node types, the evolution rules, offline playback from the zip.

- A terminal player (Python, Go, Rust, Java): walk the graph, ask the questions, apply variable actions, evaluate conditions, print the end state.
- A mobile player (Flutter, Kotlin, Swift, React Native): the same, on a phone, from a file the user picks.
- A game-engine player (Godot, Unity): the same, with the scene node rendered as an explorable space.

Marking guidance we suggest: the player should pass the shared test set (play each sample from `samples/` with a scripted set of answers and reach the documented end state), handle a file containing an unknown node type without crashing, and accept the legacy forms in spec §8.

### A semester: build the ecosystem piece that is missing

Larger, open-ended, and genuinely useful.

- **An authoring tool for one domain.** A form-based or spreadsheet-based editor that produces valid `.ronu` files for a specific subject (a nursing OSCE, a lab safety induction, a language dialogue). Lecturers in that subject are your users.
- **A converter.** From an existing course format (a slide deck with speaker notes, a Twine story, an H5P branching scenario) into `.ronu`. Document what survives and what does not.
- **An LMS plugin.** A Moodle activity module (or Canvas LTI tool) that uploads a `.ronu`, plays it in-page with the reference player, and records completion in the gradebook.
- **A record store.** Take the session record a player emits (the xAPI-shaped statements in `player/`), queue it offline, and sync it to a Learning Record Store when a network appears.
- **An extension node type.** Define `x-<yourinstitution>:<type>` for something the catalogue lacks (a chemistry titration, a code-review exercise, a map-based decision), implement it in a player, write sample files, and propose it for graduation following [CONTRIBUTING.md](../CONTRIBUTING.md).
- **A conformance suite.** A language-neutral test set (files plus expected outcomes) that any player can run. We do not have one yet. This is the single most valuable contribution a course could make.

## What we commit to

- **Answers.** Open an issue on this repository; a maintainer replies. Spec ambiguities students find are spec bugs and get fixed, with credit.
- **A path to the catalogue.** Extensions that prove useful can graduate into the core node catalogue. The process is in [CONTRIBUTING.md](../CONTRIBUTING.md) and is deliberately light: a config schema, one real implementation, sample files.
- **Visibility.** Working players, tools, and extensions get linked from the README's implementations list.
- **Stability where it matters.** The skeleton (spec §2 to §6) is intended to freeze at v1.0 roughly as it stands, and the `stable` node types keep their meaning. Student work built on those does not rot.

## What we ask

- Apache-2.0 or a compatible licence on anything you want linked, so others can build on it.
- Tell us what the spec failed to say. The reference player keeps a running list in [`player/SPEC-GAPS.md`](../player/SPEC-GAPS.md); add to it.

## Getting started with a cohort

1. Every student reads the spec and runs the reference player on `samples/hello-ronu/hello.ronu`.
2. Week one: the afternoon exercise, in the course language.
3. Weeks two to three: the player, marked against the shared samples.
4. The rest of the term: one semester-scale piece per team.

If you want to run this and would like a maintainer to talk to the cohort, open an issue titled `course: <institution>` and say when.
