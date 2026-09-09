# Spec gaps found while building the reference player

This player was written from `spec/ronu-spec.md` (the platform's current copy), the JSON Schema, the samples and the Rust reference validator. Every time the spec did not say enough to implement something, the gap is listed here with what this player does about it. The list is a deliverable: it is what the spec still has to say before an independent implementer can get identical behaviour without asking.

Two kinds of resolution appear below.

- **Looked up.** The platform's own viewer code (`src/pages/ModuleViewer/`) was read, narrowly, to find out what real files expect. Those are the ones the spec most needs to absorb, because a second implementer will not have that code.
- **Decided.** No source of truth existed, so the player made a reasonable choice and documents it. These are proposals.

The section numbers refer to the spec.

## Conditions (section 7 `condition`, section 8)

**G1. The condition operator vocabulary is not listed.** The spec gives the shape (`conditions[]{field, operator, value}`) and nothing else. *Looked up.* The operators real files use are: `exists`, `not exists`, `is true`, `is false`, `equals`, `contains`, `not contains`, `starts with`, `ends with`, `>`, `<`, `>=`, `<=`, `length >`, `length <`, `before`, `after`, `within range`. Two spellings exist in the wild, with spaces and with underscores (`is_true`, `not_exists`); readers must accept both. This player accepts both, plus `not equals`, `==`, `!=` and a few aliases. The spec should list the vocabulary and pick one canonical spelling (section 8 style: readers accept both, writers emit one).

**G2. What a `field` is compared against.** The schema says a field is "a node id or a variable id, or the literal `operator`", but not what a node id means. *Looked up:* a node id resolves to the learner's recorded answer to that node; a variable id resolves to the variable's current value (computed variables are evaluated). When the answer is a list of choice ids, `equals` and `contains` compare against the choice *labels*, so authors can write the visible text. This player does that, and also accepts a variable *name* as a tolerance (the platform does not).

**G3. How several conditions in one criteria set combine.** Not stated. *Looked up:* connector tokens are conditions whose `field` is the literal `"operator"` and whose `value` is `AND`, `OR`, `NOT`, `(` or `)`; a condition may instead carry `join: "AND"|"OR"` as a property. Precedence NOT, AND, OR. Two adjacent conditions with no connector are malformed on the platform; this player treats them as AND. The spec should define the expression grammar or, better, replace tokens-in-the-list with an explicit `combine: "all"|"any"` field.

**G4. Condition `value` is a string in real files** (`"value": "1"` in `under-the-sink`), even for numeric comparisons. *Decided:* numeric operators coerce with `Number()`. The spec should say values are compared after coercion to the field's type.

**G5. What happens when no criteria set matches and there is no `defaultTargetNodeId`.** *Decided:* follow the node's own `connection`; if none, the experience ends. The reference validator warns on this case, which suggests the spec should say "the experience ends" outright.

## Completion and scoring (section 4 `settings.completion`)

**G6. The completion rule's operator set and modes are only sketched.** From the validator: `variable` mode uses `<`, `>`, `<=`, `>=`, `is_true`, `is_false`, `contains`; `reachedNode` uses `passNodeId`; `nodeScore` uses `scoreNodeId`, `scoreAggregate`, `operator`, `value`. The legal values of `scoreAggregate` are not given anywhere. *Decided:* `average` (default), `min`, `max`, `sum` over all node scores when `scoreNodeId` is absent. When no rule exists, the end screen says "Completed" with no pass or fail.

**G7. What a node's 0 to 100 score is, per type.** The xAPI note says `answered` carries "the node's 0 to 100 grade", but no node's grade is defined. *Decided:* `matching` (when `matchingGraded` is not `false`) is the percentage of left items with a `correctRightId` matched correctly; `procedure` is the percentage of steps performed in turn; `dragToTarget` is the percentage of items placed right, a distractor counting as right only when left unused. `multipleChoice`, `ranking`, `textInput` and `rating` have no notion of a correct answer in the spec, so they carry no score.

## Triggers and timers (section 7 shared sub-schemas)

**G8. `NodeTrigger.config` keys are not documented.** *Looked up:* `onTimerElapsed` reads `config.duration` in seconds (default 30 when absent); `onVideoTimestamp` reads `config.timestamp` in seconds. `onNodeEnter`, `onNodeExit` and `onVideoComplete` take no config.

**G9. `TimerConfig.recordVariableId` semantics.** *Looked up:* the elapsed whole seconds are written with a `set` action when the node is left (node timer) or the module ends (module timer). Also undocumented and decided here: `visible` defaults to true; `warnAtSeconds` defaults to 10; a count-up timer never expires (its `onExpire` is ignored, matching the validator's warning); a module timer's `advance` behaviour has no meaning (the validator warns) and this player treats it as `end`; `sound` is ignored.

## Scenes (section 7 `scene`)

**G10. Hotspot `position` units are not given.** The schema says only "shape varies by environment". *Looked up:* `photo360` uses `{yaw, pitch}` in radians; `photo2d` uses `{x, y}` as fractions (0 to 1) of the image's width and height. Yaw 0 is the centre column of the equirectangular image, positive to the right, wrapping at plus or minus pi; pitch 0 is the horizon, positive up. `discoveryRadius` is in the same units: great-circle radians for 360 (default 0.35), image fraction for 2d (default 0.08). This player's 360 view is a flat pan of the equirectangular image, not a perspective projection (see `pano.js`), so a hotspot lands at `u = (yaw / 2pi + 0.5) * width`, `v = (0.5 - pitch / pi) * height`. Two players with different projections will show the same hotspot at slightly different screen places; the spec only needs to pin the angular convention, which it should.

**G11. Hidden hotspots and discovery.** `hidden` and `missActions` are listed but the mechanic is not described. *Looked up:* a hidden hotspot shows no marker; the learner taps the scene and the nearest unfound hidden hotspot within `discoveryRadius` counts as found, otherwise `missActions` fire. A found hotspot then behaves like a visible one. The platform also has a legacy scene-wide `hotspotVisibility: "hidden"` field that this player does not read.

**G12. What happens when a hotspot is activated, and in what order.** `reveal`, `conversation`, `targetNodeId`, `variableActions` and `interaction` are listed with no sequencing. *Looked up:* variable actions fire on first activation only; then the beats run in order conversation, interaction, reveal, and the route (`targetNodeId`) fires last. This player shows a fallback card for `conversation` (no AI backend), opens `interaction`, shows `reveal`, then routes. `reveal` is `{kind: "text"|"image"|"video", body?, src?, title?}` in the samples; the spec does not give the shape.

*Revised 9 September 2026.* An earlier copy of the spec mentioned `interaction` by name only, and this player ignored it. Section 7.2 ("Answering inside a scene") now defines it: `{type, config}` where `type` is one of the eight nestable catalogue types (`message`, `multipleChoice`, `textInput`, `matching`, `ranking`, `rating`, `procedure`, `dragToTarget`) and `config` is that type's ordinary profile; the learner answers it in the room and stays there; it never routes (`choice` and `condition` are deliberately not nestable) but its `actions[]` fire as usual; and a `required` hotspot with an interaction is only satisfied once answered, so clicking and dismissing is not enough. This player now implements all of that, treating the interaction as a sub-node that reuses the top-level type's logic and renderer. What 7.2 still leaves unsaid is split out below as G41 to G47: the sequencing sentence above is still this player's reading, not the spec's (7.2 does not say where the interaction sits relative to `conversation` and `reveal`); what an unanswered required interaction looks like; whether reading a `message` counts as answering; how `abortWhen` is evaluated; what a nested config may carry; what a nested answer is called; and what an `ordered` scene does with an interaction.

**G13. `hotspotSequence: "ordered"` and `completion: "allRequired"`.** Named but not described. *Decided:* ordered means a hotspot is locked until every earlier hotspot in the array has been visited; allRequired means Continue is disabled until every `required` hotspot has been visited. With `completion: "free"`, `required` has no effect on leaving the scene.

**G14. A scene with an empty `environment.source`** (the `under-the-sink` sample) is valid but has nothing to draw. *Decided:* a neutral backdrop, hotspots still work.

### Answering inside a scene (section 7.2, added 9 September 2026)

**G41. What an unanswered required interaction looks like, and whether it can be closed.** Section 7.2 says a required hotspot with an interaction is only satisfied once answered, and that "clicking and dismissing is not enough", which implies dismissing is possible, but it does not say what dismissing does. *Decided:* the interaction card has a Close control while unanswered; Close puts the learner back in the room, the hotspot counts as visited but not done (its marker is not marked found, the status line says "n of m required done"), and the beats after the interaction (the `reveal` and the route) are dropped for that click. Opening the hotspot again shows the interaction again; once answered, OK runs the reveal and then the route. An answered interaction cannot be answered again; reopening it shows the recorded answer, then the later beats. The spec should say whether a required interaction may be closed unanswered at all, and whether the reveal and route wait for the answer (this player) or run regardless.

**G42. Does reading a `message` interaction answer it?** Section 7.2 says a required interaction "with nothing to answer (no choices, steps, items)" is a gate the learner can never open, which read literally covers `message`. The reference validator disagrees: its unanswerable check exempts `textInput`, `rating` and `message` ("need no options"), so a required hotspot with a message interaction is not flagged. *Decided, following the validator:* a `message` interaction is answered by reading it (OK counts). A `multipleChoice`, `ranking`, `matching`, `procedure` or `dragToTarget` with an empty list is the strand the spec describes, and this player does not try to rescue the learner: it records whatever is submitted, so an empty submission still counts as answered for `multipleChoice`, `ranking`, `matching` and `dragToTarget` (Check with nothing placed scores 100), while a `procedure` with no steps can never be completed and a required hotspot carrying one is the gate that never opens. The spec and the validator should agree on the `message` case.

**G43. When `abortWhen` is evaluated.** Section 7.2 says the learner leaves "when the variable satisfies the comparison" and that an in-scene question sets the variable through its actions; it does not list the evaluation points. *Decided:* the rule is checked after every event inside the scene that can fire actions: a hotspot's first activation (`variableActions`), a miss (`missActions`), a nested interaction's answer (choice and match actions, a rating's `set`), each procedure step (`earlyActions`, so a critical misstep ejects the learner mid-procedure with the procedure unanswered), and a node timer's actions. It is checked whether or not the event actually carried actions, so a value that was already over the line when the scene was entered is noticed at the first tap, not on entry, which keeps a debrief that loops back into the room from bouncing the learner straight out again. A rule with no `targetNodeId`, or a `variableId` that does not exist, never fires (the validator warns on both). The `value` is compared exactly as a completion rule's is (G6). A firing rule records `scene-abort` and leaves through the normal exit (`onNodeExit` triggers, the node timer's `recordVariableId`), and the scene's `connection` is not followed. The spec should list the evaluation points and say whether entry counts.

**G44. What a nested `config` may carry.** Section 7.2 says `config` is "that type's ordinary profile", and an ordinary profile carries flow fields: `connection`, `advanceOnAnswer`, `showContinueButton`, `triggers`, `timer`, `required`, `allowPrevious`, `isStart`. *Decided:* all of them are ignored inside a hotspot. A nested interaction never routes, so `connection` and `advanceOnAnswer` have nothing to do; there is no Continue button to hide; nested `triggers` (`onNodeEnter`, `onNodeExit`, `onTimerElapsed`) do not fire because the sub-node is never entered or exited as a node; a nested `timer` does not run; and `required` is meaningless because the hotspot's own `required` governs. The spec should say which fields are honoured (probably only the answer fields and the per-choice, per-step and per-item `actions[]`), or the validator should warn on the rest.

**G45. What a nested answer is called.** The session record needs an identity for an answer given inside a scene, and a condition node (G2) might want to compare against it; 7.2 gives neither. *Decided:* the sub-node id is `<sceneId>/<hotspotId>`; the response and any node score are keyed by it, a condition `field` may name it, and the xAPI statement's object is the hotspot sub-activity `{iri}/nodes/{sceneId}/hotspots/{hotspotId}` (the `xapi-activity-ids.md` shape) with the interaction type as its activity type. The end screen labels the score "Scene title: hotspot label".

**G46. `hotspotSequence: "ordered"` with interactions.** G13 decided that ordered locks a hotspot until every earlier one has been *visited*. With 7.2's "visited is not enough", the natural reading is that an earlier required interaction must be *answered* before the next hotspot unlocks. *Decided, for now:* still visited, so the two rules stay independent. The spec should pick one.

**G47. A conversation's `scoreVariableId` in a minimal player.** Not a 7.2 gap but exposed by its sample: a minimal player shows a fallback for `conversation` (rule 5.2), so the score variable keeps its initial value. `margarets-room` gates the pass path on `consent_score >= 60` and loops the retry debrief back into the room, so in this player the file can only end through the `abortWhen` exit; the pass path is unreachable without an AI grader. Rule 5.2 already advises keeping critical routing out of unsupported nodes; the spec could say the same of conversation scores, or define what a minimal player writes to `scoreVariableId` (nothing, this player). The test suite stands in for the grader with full marks to walk the sample to its end.

## Other node types

**G15. `matching`: when `matchingLeftItems[].actions` fire.** *Looked up:* on submit, once per correctly matched left item. `matchingGraded` defaults to true. The spec should also say whether a right item may be matched by more than one left item (the sample does this; this player allows it).

**G16. `message`: `showContinueButton: false` and `advanceOnAnswer`.** How the learner leaves a message node without a Continue button is not said. *Decided:* the button is hidden only when the node has another exit (a countdown timer whose `onExpire.behavior` is `advance`, `route` or `end`, or `advanceOnAnswer`); otherwise it is shown regardless, so a file can never strand the learner. `advanceOnAnswer` on `multipleChoice` means a single-select pick advances by itself; with `allowMultiple` a Submit is still needed.

**G17. `config.connection` versus the node's `connection`.** The schema declares both. *Decided:* the node-level field wins; `config.connection` is read only as a fallback.

**G18. `choice.choices[].condition`.** Listed in the catalogue table, defined nowhere, and the platform viewer does not read it. Ignored here.

**G19. What a `choice` node records as its answer.** Needed for G2. *Decided:* the choice `id`, with the label kept alongside so conditions can match either.

**G20. `rating`.** The spec lists `ratingVariableId`, min, max, style and labels. Undocumented: the value is written with `set` (decided), `ratingEmoji` (in the sample, used for the `emoji` style), and whether a rating advances by itself (decided: no, unless `advanceOnAnswer`).

**G21. `ranking`.** `rankingItems[]` are plain strings in the samples; the spec does not say whether objects are allowed (this player accepts `{text}` or `{label}` too). There is no correct order and therefore no grade; the answer is the ordered list.

**G22. `required` and `allowPrevious`** appear on nearly every node in the samples and in no part of the spec. *Decided:* `required` blocks Continue on an answer node until it is answered; `allowPrevious` is ignored (this player has no Back).

**G23. `video`: page URLs versus media files.** Section 8 says absolute URLs are "playable only online" but not what to do when the URL is a YouTube or Vimeo page rather than a media file (the `fantasy-series-quiz` sample). *Decided:* those two hosts are embedded (`youtube-nocookie.com`, `player.vimeo.com`); everything else goes into a native `<video>`. `subtitlesUrl` becomes a `<track>`; `videoControls` flags other than `autoplay` and `showSubtitles` are ignored because the native controls do not expose them individually.

**G24. `procedure` (provisional).** The prose is good but leaves out: what `ifEarly` is (decided: the message shown when the step is done out of turn), when `earlyActions` fire (decided: at that moment), whether the displayed order is shuffled (decided: yes, deterministically per node id, or the answer is given away), and the score (see G7).

**G25. `dragToTarget` (provisional).** The score is not defined (see G7). `image` on items and targets is presumably a media reference; treated as one.

**G26. `note`.** Clear. Recorded here only to confirm a note with a `connection` is followed through silently (decided), so a note wired into a path does not break it.

## Variables (section 4)

**G27. Defaults and coercion.** Not stated: what a variable is worth when `initialValue` is absent (decided: 0, false, ""), whether `initialValue` is coerced to `type` (decided: yes), what `set` does with a mismatched value type (decided: coerce; a non-numeric string becomes 0), what `increment` does with no `value` (decided: 1), and what `divide` by zero does (decided: leaves the value unchanged; the formula evaluator, by contrast, yields 0).

**G28. `visible: false`.** Presumably "do not show to the learner". This player still lists hidden variables on the end screen, greyed, because the end screen is the debugging surface for a file. A conformance statement would help.

**G29. `scope: "learner"`.** Section 4 already says an offline player treats it as module-scoped. Done. Nothing carries over between files.

**G30. Placeholder grammar.** `{variableName}` with names matching `[A-Za-z0-9_]+` (taken from the validator's scan). Unknown names are left as written. Placeholders are substituted in titles, questions, instructions, content, choice labels, hotspot labels, reveal bodies and step text; the spec should say which fields are subject to substitution (this player: any string it renders).

**G31. Formula grammar** is not in the spec; it is in `rust/src/formula.rs`. The spec should reference or restate it: numbers, identifiers, `+ - * /`, unary minus, parentheses, unknown identifiers and division by zero evaluate to 0.

## Skeleton and container (sections 2 to 6)

**G32. Where the experience ends.** Never said in one sentence. Decided: a displayable node with no forward edge (no `connection`, no chosen edge, no route) ends the experience; a dangling edge (target id missing) ends it with an error rather than crashing.

**G33. Zero or several `isStart` nodes.** Section 4 says exactly one. Decided: none means the first node in the array (the validator does the same for reachability); several means the first flagged one.

**G34. A `.ronu` whose members sit under a folder** (a zip made by right-clicking a folder), and `__MACOSX` junk. Decided: tolerated; the first `module.json` found by suffix sets the prefix.

**G35. A zip with `module.json` but no `manifest.json`**, and the JSON-only interchange form. Section 2 says the manifest is required. Decided: the player synthesises a minimal manifest (`activityIri` becomes a local `urn:`) rather than refusing, so bare `module.json` files and sloppy zips still play. The spec could allow this explicitly for readers while keeping it forbidden for writers.

**G36. Which `formatVersion` majors a reader accepts.** Section 6 says "any file whose major version they support". This player accepts majors 0 and 1 and only warns otherwise.

**G37. Media reference forms.** Section 8 lists bundle paths, platform storage refs and absolute URLs. Not stated: whether `./assets/x` or `/assets/x` are legal (tolerated here), whether paths are URL-encoded (both tried), `data:` URLs in `img src` inside `message.content` (dropped by this player's sanitiser, kept for `files[].data` per section 8), and what to render when a reference cannot be resolved (this player shows the `alt` text, or "not bundled").

**G38. HTML in `message.content`.** The spec says "rich text/HTML" and nothing about which HTML. A player must sanitise (files are untrusted by design), and two players with different allowlists will render the same file differently. The spec should publish the allowed element and attribute set. This player's set is in `sanitize.js`: `p br strong em u ul ol li h1 h2 h3 h4 a[href http(s)] img[src bundle or http(s), alt] blockquote code pre`; `b`, `i` map to `strong`, `em`; everything else is unwrapped, active content dropped.

**G39. `files[]` on `message`.** `{id, name, path, mimeType}` in the sample, `data` for the legacy form. Not stated whether files are shown as a list, inline, or both. Decided: an attachments list with download links; images referenced from the content render inline as well.

## Session records (section 3, `xapi-activity-ids.md`)

**G40. Statement shapes for a local player.** The companion note fixes IRIs and verbs but assumes a platform actor and registration. For an offline player with no identity, this player uses `{"account": {"name": "local"}}` and no registration, and adds `answer-labels`, `variable-changed`, `scene-miss` and `procedure-step` extension keys beside the note's `branch-taken`, `scene-hotspot` and `timer-expiry`. The spec (or the note) should say what a player with no actor should emit, and whether the extra keys are welcome.
