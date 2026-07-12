# `.ronu` sample files

Real public modules exported from RonuNest in the **JSON-only interchange form** of the format ([spec](../spec/ronu-spec-v0.9.md) §2) — each sample is a folder holding the two required members of the zip container, unzipped for readability:

```
<sample>/
├── manifest.json   — the envelope (identity, format version, activity IRI)
└── module.json     — the experience (nodes, variables, settings)
```

| Sample | Exercises |
|---|---|
| `fantasy-series-quiz` | The classic assessment types: video, message, textInput, multipleChoice, ranking, matching, rating |
| `under-the-sink` | Immersive surface: scene (hotspots), choice, conversation, condition — plus variables and scoring |
| `legacy-branching-sample` | The **legacy tolerance rule** (spec §5.4/§8): old `router`/`decisionPath` node types and the stringified condition config, which readers MUST still accept |

Validate them all:

```bash
npx -y tsx validator/cli.ts samples/*/module.json
```

Note: media references in these samples are in the legacy platform form (storage refs), so they're playable online only — a canonical zip export bundles media under `assets/` and rewrites the references (spec §8).
