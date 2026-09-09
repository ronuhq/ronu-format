# Build a `.ronu` player in an afternoon

This is a walk through the format from the point of view of someone writing
a player, in the order you will hit things. By the end you will have a
terminal player that opens a real `.ronu` file, walks the scenario, applies
the scoring logic and reports the result. The whole thing is about 200 lines
of dependency-free JavaScript and is checked into this repository as
[`docs/examples/tiny-player.mjs`](examples/tiny-player.mjs). Run it first:

```bash
node docs/examples/tiny-player.mjs samples/hello-ronu/hello.ronu
```

Read the spec once before you start: [`spec/ronu-spec.md`](../spec/ronu-spec.md).
It is short. Sections 2 to 6 are the skeleton every player implements;
section 7 is the catalogue of node types, which you implement as many of as
you like.

## 1. A `.ronu` file is a zip

Section 2. Inside: `module.json` (the experience), `manifest.json` (identity
and titles), and `assets/` (bundled media). `module.json` is the only member
you strictly need to play. The example reads the zip with Node's built-in
`zlib` so there is nothing to install; in a browser, [fflate](https://github.com/101arrowz/fflate)
is the usual choice (the reference player vendors it).

Accept a bare `module.json` too. The samples in this repository are stored
that way, unzipped, so they can be read on GitHub.

## 2. The graph

Section 4. `module.json` has `nodes[]`, `variables[]` and `settings`. Every
node has an `id`, a `type`, a `title`, a `config` object whose shape depends
on the type, and usually a `connection`: the id of the node that comes next.
Exactly one node has `config.isStart: true`.

A player is a loop:

```
current = the start node
while current:
    render current
    next = current.connection
    (a choice picks its own next; a condition computes one)
    current = nodes[next]
```

That loop is the whole skeleton. Everything else is what happens inside
"render".

## 3. Variables and actions

Section 4 and the shared sub-schemas at the end of section 7. Variables are
declared once with an `id`, a `name`, a `type` (`number`, `boolean`,
`string`) and an `initialValue`. Things that happen during play carry
`actions[]`: `{variableId, operator, value}` with operators `set`,
`increment`, `decrement`, `multiply`, `divide`, `set_true`, `set_false`,
`toggle`. A choice's actions fire when it is picked. Node `triggers[]` fire
actions on enter, exit, timer and video events.

Text may contain `{variableName}`; substitute the current value when you
render.

## 4. The three node types that make it a simulation

- **`message`**: show `config.content` (HTML; sanitise it, the file is untrusted) and continue.
- **`choice`**: show `config.question` and `config.choices[]`. Each choice has `text`, `actions[]` and its own `connection`. The learner's pick decides the path.
- **`condition`**: no UI. `config.criteria.criteriaSets[]` is a list of alternatives; the first set whose conditions all hold routes to its `targetNodeId`, otherwise `defaultTargetNodeId`. A condition is `{field, operator, value}` where `field` is a variable id or a node id (meaning "the answer given at that node").

With those three you can play `hello-ronu`, `under-the-sink` and the legacy
sample. That is the afternoon.

## 5. The two rules you must not break

Section 5. They are what let a player written today play a file written
next year.

1. **Ignore what you do not understand.** Unknown fields anywhere are fine. Unknown action operators do nothing.
2. **An unknown node type is a placeholder, not a crash.** Show its title, offer Continue, follow its `connection`. Types under an `x-` namespace are the same. The example prints `[type] title (not supported, continuing)`.

And the legacy rule (section 8): old files say `router` and `decisionPath`
where new ones say `choice` and `condition`, and an old condition keeps its
criteria as a JSON string in `config.choices`. Readers accept both forever.
Writers only ever emit the canonical form.

## 6. Finishing

The experience ends when there is nowhere to go. Then apply
`settings.completion`: in `variable` mode it is `{variableId, operator, value}`
against a variable, and that is the pass rule. Print the variables and the
verdict.

## What the example leaves out, and where to find it

The example stops at the skeleton plus `message`, `choice` and `condition`.
The reference player in [`player/`](../player) implements the rest of
conformance level 1 (section 6): the assessment types (`textInput`,
`multipleChoice`, `ranking`, `matching`, `rating`), timers, `scene` with
hotspot discovery, media resolution from the bundle, an HTML allowlist, a
session record, and offline operation as a PWA. It is plain JavaScript with
the engine ([`player/engine.js`](../player/engine.js)) kept free of the DOM
so it can be tested in Node, and its tests walk every sample in this
repository. Read `engine.js` when your own player reaches a question the
spec does not answer, and then read [`player/SPEC-GAPS.md`](../player/SPEC-GAPS.md),
which is the list of exactly those questions with the choices the reference
player made.

## Checking your player

- Every file under `samples/` should play to an end without an exception. Two of them (`barrier-cream-round`, `margarets-room`) use provisional types; a level-1 player shows placeholders for those and still finishes.
- Validate anything you *write* with the reference validator before you share it: `cargo run --manifest-path rust/Cargo.toml --bin ronu -- validate module.json`, or the [wasm binding](../bindings/wasm) from JavaScript.
- If your player and the reference player disagree on a sample, one of them has found a spec gap. Open an issue; that is how the spec gets better.
