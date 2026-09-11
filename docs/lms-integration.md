# `.ronu`, SCORM and xAPI: how they fit, and what an LMS gets

Enterprise buyers ask one question: "do you have this as SCORM so we can put it in our LMS?" This page is the answer, and the limits behind it. It is deliberately plain.

## Three layers that "SCORM" usually lumps together

| Layer | What it is | The enterprise standard | What `.ronu` does |
|---|---|---|---|
| **The package**: what a course *is*, as a file | The thing you import | SCORM zip: a manifest plus HTML pages. Linear. No variables, branching or scoring logic in the format | `.ronu`: a zip holding the whole simulation, branching, scoring logic and media. This is the layer SCORM cannot express and nobody else has an open format for |
| **The record**: what the learner *did* | Events during play | xAPI (Experience API): statements of actor, verb, object, sent to a Learning Record Store (LRS). Older: the SCORM runtime API, completion and score only | The session record a player builds is xAPI-shaped: ADL verbs, activity IRIs pinned in the format, node-level detail as extensions. The reference player sends it to a receiver (RonuNest); an LRS feed is the same statements at another address |
| **The hand-off**: how it shows up in *their* LMS | Import, launch, report back | "Import the SCORM package" | Never the `.ronu` itself. A SCORM package that either launches the hosted module or carries the player and the file inside |

So: xAPI is complementary to `.ronu` (events versus the experience), and SCORM is a rival only at the package layer, where we do not fight it. We wrap, we do not convert.

## Who owns what

- **SCORM** was created by ADL, the US Department of Defense's Advanced Distributed Learning initiative, in 2000. ADL still governs it.
- **xAPI** started as Project Tin Can, a 2010 research contract ADL awarded to Rustici Software; version 0.9 shipped and the spec passed to an open community under ADL, which named it the Experience API in 2013.
- **Rustici Software** (founded 2002) did not invent SCORM. They are the best-known commercial implementers: SCORM Cloud (hosted testing and delivery), SCORM Engine and Content Controller (licensed to LMS vendors), and Dispatch (their name for the launcher-package pattern below).

## The two SCORM deliverables

| | Connected package | Self-contained package |
|---|---|---|
| What is in the zip | The reference player, the `.ronu` file, the SCORM API adapter, and `ronu-package.json` holding the customer's key | The reference player, the `.ronu` file, the SCORM API adapter |
| Where the simulation runs | Inside the LMS; the player talks to the platform for the learner | Entirely inside the LMS, no calls out required |
| Needs internet from the learner's browser | Yes, to reach the platform (the module itself still plays if it cannot) | No, unless optional services are used |
| AI conversation characters | Yes, live, for the LMS's learner, with no popup and no RonuNest account | Only if the learner connects through the popup handshake. Air-gapped: no |
| Content updates | Re-import the zip | Re-import the zip |
| What the LMS receives | Completion, score, time, session state: everything SCORM 1.2 can carry | The same |
| What the platform receives | The full play-through, recorded automatically at the end: node-level evidence, certificates, analytics, under a tenant learner keyed to the LMS's student id | Nothing, unless the learner connects and sends, or an xAPI feed goes to the customer's LRS |
| Answers "we host it ourselves" | Yes (the platform is called, not loaded from) | Yes |
| Answers "we are air-gapped" | No (it degrades to self-contained) | Yes, with the AI fallback |
| State | Built: `node player/tools/scorm-package.mjs <file.ronu> --receiver https://ronunest.com --key <customer API key>`; the platform side is `player_session` on `creator-api` (section 7 of `docs/record-receiver.md`) | Built: `node player/tools/scorm-package.mjs <file.ronu>`; see "Packaging for an LMS (SCORM 1.2)" in `player/README.md` for the zip, the fake-LMS harness and the limits |

The "dispatch" launcher (a package that is only a launcher page loading the hosted module) is a third shape, not built: with a connected package there is no need for it in the first deals, because updates are the one thing it adds, and a re-import covers that.

Both flavours are the same zip; the connected one adds one file and one launch flag. Both play offline when the platform cannot be reached, so a connected package is never worse than a self-contained one.

Both report to the LMS through the standard SCORM runtime API (`LMSInitialize`, `LMSSetValue cmi.core.lesson_status` and `cmi.core.score.raw`, `LMSCommit`, `LMSFinish` in 1.2 terms). Open-source adapters for that API have existed for years (the pipwerks SCORM API wrapper, MIT, since 2008; scorm-again, MIT, covers 1.2, 2004 and AICC). Writing the package side is not the hard part. The hard part is conformance across hundreds of LMS implementations, which is what a test harness such as SCORM Cloud is for.

Target SCORM 1.2, not 2004: 1.2 is the universal denominator and the ceiling of several large LMSs.

## Build or buy

- **Build the packages ourselves.** A launcher or a self-contained package is a small amount of code on top of the reference player plus an open-source API adapter. Nothing here requires a vendor.
- **Buy conformance testing, cheaply.** SCORM Cloud has a free Trial plan (3 courses) and a Tester plan at 40 US dollars a month (10 resettable registrations, prices as published August 2023). That is enough to prove a package imports and reports correctly before it goes near a customer LMS.
- **Consider Rustici Dispatch only for managed distribution at scale**: per-customer packages, revocation, central analytics across many customer LMSs. It is a monthly subscription priced by registrations (a registration is one learner enrolled in one course): Little 90, Medium 180, Big 360, Bigger 1,100 US dollars a month for 50, 100, 300 and 4,000 registrations a month respectively, with overage per registration above the plan; SCORM Engine, the embedded licence, is quoted separately and costs materially more. Ongoing, not one-off. None of it is needed for the first deals.

## What the self-contained package cannot do, honestly

- **AI characters need a model on a server.** "Self-contained" means hosted in the LMS, not necessarily offline. If the learner's browser can reach the platform, the package can run conversations through it, provided it carries a credential for the learner: the connect handshake in `record-receiver.md` (the learner signs in), or the customer key of a connected package (section 7 of that contract, no sign-in). On a truly air-gapped LMS there is no model, so the node falls back to the spec's placeholder; authors who need that case write the dialogue as an ordinary branching `choice` tree instead.
- **Certificates, analytics and evidence** stay in the LMS's own terms (a status and a score) unless the package is a connected one, or the learner sends the record, or an xAPI feed goes to the customer's LRS.
- **Updates** need a re-import, for both flavours.
- **Learner-scoped variables** shared across modules, group features, leaderboards, community: platform features, absent.
- **3D worlds and code nodes** show the fallback card; the player does not ship those runtimes.
- **Video** is bundled, not streamed, so package size grows with media.

## The one-sentence answer for a sales call

"Yes. Every module comes as a standard SCORM 1.2 package your LMS imports like any other course. Choose the connected package for live AI characters and a full record on our side, with no accounts for your learners, or the self-contained package if nothing may leave your network. Completions and scores land in your LMS either way, and if you run an LRS we can send full xAPI detail too."
