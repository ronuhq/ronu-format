# `.ronu` sample files

Two kinds of sample live here.

## An actual `.ronu` file — [`hello-ronu/`](hello-ronu)

[`hello-ronu/hello.ronu`](hello-ronu/hello.ronu) is a real, self-contained `.ronu` file: the smallest complete experience (four nodes, one variable, a pass rule) with a **bundled cover image**. It's the artifact to reach for when you want to see what the format actually *is* on disk.

```
hello-ronu/
├── hello.ronu          ← the real file (a zip). Try:  unzip -l hello-ronu/hello.ronu
├── manifest.json       ← its envelope, unpacked for easy reading on GitHub
├── module.json         ← its experience, unpacked
└── assets/01-cover.png ← the bundled image, referenced from module.json as "assets/01-cover.png"
```

The loose files are exactly the contents of `hello.ronu` — unzipped so you can browse them without downloading. Note how media is referenced: `module.json` points at `assets/01-cover.png` (a relative path into the zip), and the manifest lists that asset. This is the canonical, offline-portable form — the file plays with no network.

## Unzipped interchange samples (real modules from RonuNest)

The other folders are real public modules exported in the **JSON-only interchange form** ([spec](../spec/ronu-spec-v0.9.md) §2) — just the two JSON members, no bundled media:

| Sample | Exercises |
|---|---|
| `fantasy-series-quiz` | The classic assessment types: video, message, textInput, multipleChoice, ranking, matching, rating |
| `under-the-sink` | Immersive surface: scene (hotspots), choice, conversation, condition — plus variables and scoring |
| `legacy-branching-sample` | The **legacy tolerance rule** ([spec](../spec/ronu-spec-v0.9.md) §5.4/§8): old `router`/`decisionPath` node types and the stringified condition config, which readers MUST still accept |

Their media references are in the legacy platform form (storage refs), so they're playable online only — `hello-ronu` is the one to study for the offline, bundled-media form.

## Validate them all

```bash
# reference validator (structure + semantics)
npx -y tsx ../validator/cli.ts */module.json

# JSON Schema (structure), any language
npx -y ajv-cli@5 validate --spec=draft2020 --strict=false \
  -s ../schema/ronu-module.schema.json -d "*/module.json"
```

All four validate clean.
