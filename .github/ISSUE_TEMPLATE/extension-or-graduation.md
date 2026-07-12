---
name: Extension or graduation proposal
about: Propose a namespaced node type for graduation into the core catalogue, or a change to a stable type
title: "graduation: <node type>"
labels: ["proposal"]
---

<!-- For everyday use you do NOT need this: create extension node types under your own
     namespace (x-yourname:type) with no permission. Use this only to propose graduating
     an extension into the core catalogue, or changing an existing type. See CONTRIBUTING.md. -->

**What the node type does**
A sentence or two.

**Config schema**
The fields it adds under `config`, with types.

**At least one real implementation**
Link to a player/editor that reads or writes it.

**Sample file(s)**
Attach or link a `.ronu` (or `module.json`) that exercises it.

**Which promise are you asking for?**
- [ ] Graduate `x-…:` extension into the catalogue as `provisional`
- [ ] Promote an existing `provisional` type to `stable` (evidence the shape has stopped moving)
- [ ] Change/extend a `stable` type (note: must be additive, or go through legacy/canonical — spec §5)
