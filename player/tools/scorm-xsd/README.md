# SCORM 1.2 schema files

The four XML Schema control files that SCORM 1.2 (Content Aggregation Model,
section 3.4) says must sit at the root of a content package next to
`imsmanifest.xml`:

| File | Owner |
|---|---|
| `ims_xml.xsd` | IMS Global Learning Consortium (the `xml` namespace attributes) |
| `imscp_rootv1p1p2.xsd` | IMS Global Learning Consortium, Content Packaging 1.1.2 (copyright 2001 IMS GLC) |
| `imsmd_rootv1p2p1.xsd` | IMS Global Learning Consortium, Meta-Data 1.2.1 |
| `adlcp_rootv1p2.xsd` | Advanced Distributed Learning, the SCORM 1.2 content packaging extensions |

They are copied unchanged, with their notices intact, from the SCORM 1.2
"Golf Explained" content packaging examples that Rustici Software publishes
at scorm.com (`ContentPackagingSingleSCO_SCORM12.zip`), which carry the same
files ADL shipped with the SCORM 1.2 specification. Every SCORM 1.2 package
ships them, because the specification requires them at the package root;
they are not part of the player and carry their owners' terms, not this
repository's licence.

`scorm-package.mjs` copies them into every package it builds so packaging
works offline. Most LMSs never read them, but some strict validators do.
