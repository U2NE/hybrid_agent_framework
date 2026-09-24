# SPEC — OMC Deep Interview Port

## Goal

Port the pinned OMC deep-interview clarification semantics into the existing Hybrid Node requirements/state architecture with minimal unrelated changes.

## Topology

1. Threshold/gate policy.
2. Round 0 topology confirmation.
3. Iterative weakest component × dimension interview loop.
4. Brownfield Scout-first evidence handling.
5. Challenge/stall/stop behavior.
6. Durable clarification state + SPEC provenance.
7. Deterministic runtime smoke Case D.

## Constraints

- Preserve canonical Node implementation.
- Preserve Luna/Sol routing, scheduler, installer, and flat-dispatch.
- Do not add per-dimension hard floors.
- Do not create a second requirements engine or Python implementation.
- .planning/ remains canonical.
- hybrid-state/v1 remains backwards compatible.
- OMC-derived behavior and Hybrid-specific adaptations must be distinguishable.

## Non-goals

- No recursive challenge agent tree.
- No OMC file-layout clone.
- No changes to model routing, scheduler, installer, or agent topology.
- No fake interactive Case D success.

## Acceptance Criteria

- Default threshold remains 0.20 and can be policy-overridden.
- Round 0 happens before ambiguity scoring and locks confirmed topology.
- Active sibling components cannot mask one another.
- One question is selected per round from the global weak component × dimension frontier.
- Every answer re-scores and recomputes ambiguity/target.
- Brownfield facts require Scout evidence rather than user fact questions.
- Challenge/stall/stop behavior matches pinned OMC semantics.
- Early exit/hard cap cannot report normal pass.
- Clarification state resumes through hybrid-state/v1.
- SPEC records clarification provenance and remains pending approval.
- Case D report is asserted semantically.
- Full regression suite passes.
