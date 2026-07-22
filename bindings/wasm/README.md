# `@ronu/wasm` — the validator, in JavaScript

WebAssembly bindings for the `.ronu` reference validator. This runs the **actual
Rust validator** (the single source of truth) in any JS runtime — browser or
Node — so a JavaScript project never has to reimplement the rules.

The intended first consumer is [RonuNest](https://ronunest.com) itself: it can
drop its hand-written TypeScript validator and call this instead, so the
platform and the format can't disagree about what's valid.

## Build

Needs the Rust toolchain and [`wasm-pack`](https://rustwasm.github.io/wasm-pack/).

```bash
# from the repo root
wasm-pack build bindings/wasm --target web      # for browsers / bundlers (Vite)
wasm-pack build bindings/wasm --target nodejs   # for Node
```

The npm package lands in `bindings/wasm/pkg/` (git-ignored — it's a build
artifact; CI/publish rebuilds it).

## Use

```js
import init, { validate } from "./pkg/ronu_wasm.js"; // --target web
await init();                                          // load the .wasm (once)

const result = validate(moduleJsonString);
// { valid: boolean, errors: Issue[], warnings: Issue[] }
```

(With `--target nodejs` there's no `init()` — just `const { validate } = require("./pkg")`.)

### Return shape

`validate(moduleJsonString)` returns exactly what the platform's TypeScript
validator returns, so it's a drop-in replacement:

```ts
interface ValidationIssue { code: string; message: string; nodeId?: string }
interface ValidationResult {
  valid: boolean;          // false if there are any errors
  errors: ValidationIssue[];   // module is broken for learners
  warnings: ValidationIssue[]; // legal but suspicious
}
```

It throws (rejects with a string) if the argument isn't valid JSON.

> **Note:** wasm-pack types the return as `any` in the generated `.d.ts`. When a
> consumer wires this in, declare the return as `ValidationResult` (above) — a
> typed wrapper is part of the platform-integration step, not shipped here yet.

## What this is not

The JSON Schema ([`../../schema`](../../schema)) covers *shape* in any language
without wasm. This binding adds the *semantic* checks (single start node, no
dangling connections, reachability, typed actions) that a schema can't express.
