# Spec gaps: the resolution ledger

This file began as the list of everything `spec/ronu-spec.md` failed to say when the reference player was written from it, with the choice the player made each time. On 12 September 2026 every gap was written into the spec as normative text (section 9, "Player semantics") or into the record-receiver contract (`docs/record-receiver.md`). The file is now the audit trail: the numbering and one-line titles are kept, each entry names the section that resolves it, and where the written rule differs from what the player originally decided the difference is one sentence. New gaps are pull requests against the spec, not entries here. The engine's `G<n>` comments still point at these numbers.

Section numbers are the spec's after the renumbering of 12 September 2026 (the old sections 9 to 11 are now 10 to 12).

## Conditions

**G1. The condition operator vocabulary is not listed.** Resolved in spec section 9.3. The canonical spelling is the underscore form (`is_true`, `not_exists`, `length_>`), matching the completion and abort rules; the space-separated form is the accepted legacy spelling, and the symbolic aliases the player accepts are SHOULD.

**G2. What a `field` is compared against.** Resolved in spec section 9.3.

**G3. How several conditions in one criteria set combine.** Resolved in spec section 9.3, as the connector-token grammar the player implements; no `combine` field was added.

**G4. Condition `value` is a string in real files.** Resolved in spec section 9.3.

**G5. No criteria set matches and there is no `defaultTargetNodeId`.** Resolved in spec section 9.3.

## Completion and scoring

**G6. The completion rule's operator set and modes are only sketched.** Resolved in spec section 9.4.

**G7. What a node's 0 to 100 score is, per type.** Resolved in spec section 9.4.

## Triggers and timers

**G8. `NodeTrigger.config` keys are not documented.** Resolved in spec section 9.5. The spec also names `config.seconds` as an accepted alias of `duration`, which the player already read but this file did not say.

**G9. `TimerConfig.recordVariableId` semantics.** Resolved in spec section 9.5, including that a node timer's `end` behaviour ends the experience in place without writing it.

## Scenes

**G10. Hotspot `position` units are not given.** Resolved in spec section 9.6. Yaw is periodic and readers must reduce it modulo 2π; the `showcase` sample carries a yaw of 3.40.

**G11. Hidden hotspots and discovery.** Resolved in spec section 9.6. The legacy `hotspotVisibility` field stays outside the format (see Still open).

**G12. What happens when a hotspot is activated, and in what order.** Resolved in spec section 9.6, including the `reveal` shape.

**G13. `hotspotSequence: "ordered"` and `completion: "allRequired"`.** Resolved in spec section 9.6.

**G14. A scene with an empty `environment.source`.** Resolved in spec section 9.6; a missing `kind` is also played as `photo360`.

### Answering inside a scene

**G41. What an unanswered required interaction looks like, and whether it can be closed.** Resolved in spec section 9.6 ("Dismissal"): it may be closed, and the reveal and route wait for the answer.

**G42. Does reading a `message` interaction answer it?** Resolved in spec section 9.6: yes, following the validator.

**G43. When `abortWhen` is evaluated.** Resolved in spec section 9.6 ("Early exit"); entry does not count.

**G44. What a nested `config` may carry.** Resolved in spec section 9.6: only the answer fields and the per-choice, per-match and per-step `actions[]`.

**G45. What a nested answer is called.** Resolved in spec sections 9.6 and 9.4 (`<sceneId>/<hotspotId>`).

**G46. `hotspotSequence: "ordered"` with interactions.** Resolved in spec section 9.6: ordered locks on visited, not answered.

**G47. A conversation's `scoreVariableId` in a minimal player.** Resolved in spec section 9.6: nothing is written.

## Other node types

**G15. `matching`: when `matchingLeftItems[].actions` fire.** Resolved in spec section 9.7.

**G16. `message`: `showContinueButton: false` and `advanceOnAnswer`.** Resolved in spec section 9.7. One refinement: `advanceOnAnswer` counts as another way out only on a node that can be answered, so a message with `showContinueButton: false` and `advanceOnAnswer: true` still shows the button (the player's footer currently hides it).

**G17. `config.connection` versus the node's `connection`.** Resolved in spec section 9.1.

**G18. `choice.choices[].condition`.** Resolved in spec section 9.7: ignored (see Still open).

**G19. What a `choice` node records as its answer.** Resolved in spec section 9.7.

**G20. `rating`.** Resolved in spec section 9.7.

**G21. `ranking`.** Resolved in spec section 9.7.

**G22. `required` and `allowPrevious`.** Resolved in spec section 9.1 ("Continue").

**G23. `video`: page URLs versus media files.** Resolved in spec section 9.7 (embedding is SHOULD).

**G24. `procedure` (provisional).** Resolved in spec section 9.7; the shuffle is SHOULD, the misstep and score rules are MUST.

**G25. `dragToTarget` (provisional).** Resolved in spec sections 9.4 and 9.7.

**G26. `note`.** Resolved in spec section 9.1.

## Variables

**G27. Defaults and coercion.** Resolved in spec section 9.2.

**G28. `visible: false`.** Resolved in spec section 9.2.

**G29. `scope: "learner"`.** Resolved in spec section 9.2.

**G30. Placeholder grammar.** Resolved in spec section 9.2, with the list of fields subject to substitution.

**G31. Formula grammar.** Resolved in spec section 9.2, stated in full. The result is rounded to six decimals, as the validator and the platform do; the player's `formula.js` does not round yet (see Still open).

## Skeleton and container

**G32. Where the experience ends.** Resolved in spec section 9.1.

**G33. Zero or several `isStart` nodes.** Resolved in spec section 9.1.

**G34. A `.ronu` whose members sit under a folder, and `__MACOSX` junk.** Resolved in spec section 9.9.

**G35. A zip with `module.json` but no `manifest.json`, and the JSON-only form.** Resolved in spec section 9.9: allowed for readers, still forbidden for writers.

**G36. Which `formatVersion` majors a reader accepts.** Resolved in spec section 9.9.

**G37. Media reference forms.** Resolved in spec section 9.8.

**G38. HTML in `message.content`.** Resolved in spec section 9.8 as a table; the minimum kept and dropped sets are MUST, the exact set is SHOULD.

**G39. `files[]` on `message`.** Resolved in spec section 9.8.

## Session records

**G40. Statement shapes for a local player.** Resolved in spec section 9.4 ("Records built locally"): the placeholder actor and no registration are SHOULD, the extension keys MAY.

## Record receivers

**G48. Which manifest field is `moduleId`.** Resolved in contract section 3: `manifest.module.versionId`, with `module.id` read first if a future exporter writes it, and never `familyId`.

**G49. `maxTurns` and what ends a conversation.** Resolved in contract section 4.

**G50. Degraded replies.** Resolved in contract section 4: the finalize waits for one tap.

**G51. Sending the rubric.** Resolved in contract section 4: the player sends `criteria` on finalize; the receiver may ignore it.

**G52. The assessment envelope.** Resolved in contract section 4: both the wrapped and the bare form.

**G53. What "a session" is for the once-only rule.** Resolved in contract section 3.

**G54. Characters inside a scene.** Resolved in contract section 4.

**G55. The 401 row.** Resolved in contract section 3.

**G56. The no-popup route.** Resolved in contract section 2.

**G57. The refresh response.** Resolved in contract section 2.

**G58. The 413 trim.** Resolved in contract section 3 (512 bytes per answer).

**G59. Plain `http`.** Resolved in contract section 6.

**G60. Which origin the certificate link uses.** Resolved in contract section 3: `receiver.origin` from the message.

## Still open

Things the text could not make normative, and why.

- **`hotspotVisibility: "hidden"` (G11).** A legacy scene-wide field on the platform that the spec never listed. Adopting it as a section 8 legacy form needs the platform to confirm its exact meaning (does it hide every hotspot, or only those without `hidden: false`?); until then the spec says the reference player ignores it, and a file that relies on it plays differently here than on the platform.
- **`choices[].condition` on `choice` nodes (G18).** Listed in the catalogue with no definition, and unread by the platform viewer. The spec says players ignore it. It should either be defined by the platform or dropped from the catalogue table; dropping is additive-safe because nothing reads it, but is the platform's call.
- **`rubric` versus `criteria` (G51).** A conversation node calls its rubric `rubric`; a hotspot character calls the same thing `criteria`. Unifying the name would be a rename, which the skeleton promise forbids; readers accept both and the contract sends `criteria`. It stays a documented inconsistency.
- **Video triggers on embedded page players (G23, section 9.5).** `onVideoComplete` and `onVideoTimestamp` need playback events that a YouTube or Vimeo embed only exposes through host APIs. The spec can say they do not fire on the reference player's embed; it cannot require a second player to wire the host API, so a file whose variables depend on a page-hosted video will differ between players.
- **Formula rounding in the reference player (G31).** The spec makes six-decimal rounding a MUST because the validator (`rust/src/formula.rs`) and the platform do it; `player/formula.js` does not round yet. That is a player follow-up, not a spec gap.
- **A conformance suite.** Section 9 is now normative, but nothing outside the reference player's own tests exercises it. The spec's "Road to v1.0" names the suite as the next gate.
