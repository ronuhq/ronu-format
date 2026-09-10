# `.ronu` sample files

Two kinds of sample live here: real `.ronu` files with their media bundled, and unzipped JSON-only interchange exports.

## An actual `.ronu` file: [`hello-ronu/`](hello-ronu)

[`hello-ronu/hello.ronu`](hello-ronu/hello.ronu) is a real, self-contained `.ronu` file: the smallest complete experience (four nodes, one variable, a pass rule) with a **bundled cover image**. It's the artifact to reach for when you want to see what the format actually *is* on disk.

```
hello-ronu/
├── hello.ronu          ← the real file (a zip). Try:  unzip -l hello-ronu/hello.ronu
├── manifest.json       ← its envelope, unpacked for easy reading on GitHub
├── module.json         ← its experience, unpacked
└── assets/01-cover.png ← the bundled image, referenced from module.json as "assets/01-cover.png"
```

The loose files are exactly the contents of `hello.ronu`, unzipped so you can browse them without downloading. Note how media is referenced: `module.json` points at `assets/01-cover.png` (a relative path into the zip), and the manifest lists that asset. This is the canonical, offline-portable form: the file plays with no network.

## The showcase: [`showcase/`](showcase)

[`showcase/showcase.ronu`](showcase/showcase.ronu) is a real module exported from RonuNest **with all ten of its media files bundled** (4.8 MB): a 360 photo scene with a hotspot per guest, each opening a scored visual conversation, then a condition that routes on the combined floor score. It is what the [reference player](../player) opens on "Try": the first thing you see is a real room, not a blank backdrop.

```
showcase/
├── showcase.ronu       ← the real file (a zip). Try:  unzip -l showcase/showcase.ronu
├── manifest.json       ← its envelope, unpacked: ten assets with sizes and MIME types
└── module.json         ← its experience, unpacked: message → scene → condition → two endings
```

The media itself lives only inside the zip (referenced from module.json as
"assets/NN-name.ext"): the equirectangular panorama behind the scene, six
character sprites with alpha for the conversations, two conversation
backgrounds and the cover named by manifest.module.thumbnail. Unzip it to see
them; keeping a loose copy would double the repository for no reader's benefit.

| Sample | Exercises |
|---|---|
| `showcase` | The bundled-media form end to end: `scene` (`photo360` with a bundled panorama and four hotspots, each carrying a `conversation` with sprites and a background), five variables, a canonical `condition` on the combined score, and a variable-based completion rule with a certificate |

Media provenance: the panorama is Poly Haven's `bush_restaurant` (CC0); the sprites, portraits, backgrounds and cover are images generated for RonuNest. Everything is downscaled from the platform originals (the panorama from 8192x4096 to 4096x2048, the rest to 512 or 1024 px) so the sample stays small; the platform exporter itself bundles media byte-for-byte.

## Unzipped interchange samples (real modules from RonuNest)

The other folders are real public modules exported in the **JSON-only interchange form** ([spec](../spec/ronu-spec.md) §2): just the two JSON members, no bundled media:

| Sample | Exercises |
|---|---|
| `fantasy-series-quiz` | The classic assessment types: video, message, textInput, multipleChoice, ranking, matching, rating |
| `under-the-sink` | Immersive surface: scene (hotspots), choice, conversation, condition, plus variables and scoring |
| `legacy-branching-sample` | The **legacy tolerance rule** ([spec](../spec/ronu-spec.md) §5.4/§8): old `router`/`decisionPath` node types and the stringified condition config, which readers MUST still accept |
| `barrier-cream-round` | Assessed by doing: `procedure` (a care-home cream round with critical steps and their consequences), `dragToTarget` (with a distractor), canonical condition criteria, and a `conversation` graded against a rubric |
| `margarets-room` | Answering inside a scene ([spec](../spec/ronu-spec.md) §7.2): a 360 room whose hotspots carry nested `procedure`, `multipleChoice`, `dragToTarget` and `message` interactions, a character with rubric criteria, a hidden discovery hotspot, and an `abortWhen` early exit |

The two care-home samples are hand-authored in the interchange form rather than exported from a live module. Their media references (where any) are in the legacy platform form (storage refs), so the interchange samples are playable online only; `hello-ronu` and `showcase` are the ones to study for the offline, bundled-media form.

## Validate them all

```bash
# reference validator (structure + semantics)
cargo run --manifest-path ../rust/Cargo.toml --bin ronu -- validate */module.json

# JSON Schema (structure), any language
npx -y ajv-cli@5 validate --spec=draft7 --strict=false \
  -s ../schema/ronu-module.schema.json -d "*/module.json"
```

All seven validate clean (zero errors; `under-the-sink` and `legacy-branching-sample` carry deliberate warnings), and the [differential test](../rust/tests/samples.rs) pins each one's exact issue codes to what the platform validator reports.
