# .ronu reference validator

The executable arbiter of a valid `module.json` per the [spec](../spec/ronu-spec-v0.9.md) §6. Pure TypeScript functions — no DOM, no network, zero runtime dependencies.

## CLI

From the repository root:

```bash
npx -y tsx validator/cli.ts samples/*/module.json
```

## As a library

```ts
import { validateModuleContent } from "./validator/index";

const result = validateModuleContent(JSON.parse(moduleJson));
// { valid: boolean, errors: ValidationIssue[], warnings: ValidationIssue[] }
```

**Errors** mean the module is broken for learners: dangling connections, no start node, actions targeting nonexistent variables, invalid timers, malformed condition criteria. **Warnings** mean legal-but-suspicious: unreachable nodes, inert hotspots, missing condition defaults.

The full TypeScript definitions for every node profile in the catalogue live in [`src/types.ts`](src/types.ts) — for a player author, that file plus the spec is the whole contract.

## Provenance

Vendored from the originating RonuNest platform implementation (v0.9 baseline, 12 July 2026); the platform's own builder, copilot, and import pipeline run this exact logic. It will be published to npm when the spec skeleton freezes at v1.0.
