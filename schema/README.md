# JSON Schema for `.ronu`

[`ronu-module.schema.json`](ronu-module.schema.json) — a [JSON Schema](https://json-schema.org/) (draft 2020-12) for the `module.json` member of a `.ronu` file. Use it to validate modules, or to generate types/parsers, in any language with a JSON Schema toolchain.

```bash
npx -y ajv-cli@5 validate --spec=draft2020 --strict=false \
  -s schema/ronu-module.schema.json -d "samples/*/module.json"
```

## Scope — read this before relying on it

The schema is deliberately split from the reference validator along the line between *shape* and *meaning*:

- **The schema checks shape** — the top-level `nodes`/`variables`/`settings` structure, variable types and scopes, variable-action operators, and the pass-rule and timer enums.
- **The reference validator ([`../validator`](../validator)) checks meaning** — exactly one start node, no dangling connections, reachability from the start, action operators that agree with their variable's type, condition-config parseability. These are cross-node or cross-field rules that JSON Schema cannot express; a module can be schema-valid and still be a broken experience. For a real conformance check, run both.

## Two deliberate lenience choices

The format's own rules force the schema to be permissive in two places — this is faithful, not sloppy:

1. **Unknown fields are allowed everywhere** (spec §5.1, *must-ignore*). The schema never sets `additionalProperties: false`, so a newer file with fields this schema predates still validates.
2. **`node.type` is an open string, not an enum** (spec §5.2–§5.3). Unknown node types and namespaced extensions (`x-yourlab:experiment`) are valid by design, so the schema cannot whitelist types. The known core types and legacy aliases are listed in the `type` field's `description`.

`node.config` is likewise loosely typed — per-type config profiles live in the spec's node catalogue (§7), and some are still provisional. The schema validates a few stable config fields (`isStart`, `choices`, `criteria`, `triggers`, `timer`) when they're present.
