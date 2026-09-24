# IMPLEMENTATION — OMC Deep Interview Port

Implemented in-place on the existing Node requirements engine.

## OMC semantics ported

- configurable threshold with default 0.20;
- one-time Round 0 topology lock;
- active-component weak-pair selection;
- per-answer re-scoring;
- sibling anti-masking and rotation;
- brownfield Scout-first behavior;
- one question per round;
- challenge modes and stall reframe;
- early exit, soft warning, hard cap, pause semantics;
- spec-ready → pending approval;
- resumable interview state.

## Hybrid-specific integration

- clarification is stored inside existing hybrid-state/v1;
- Hybrid SPEC structure is retained with an appended clarification-provenance section;
- numeric 0.05 tolerance is used to deterministically interpret OMC's “similarly weak” sibling rotation wording;
- existing required goal/topology/acceptance fields remain part of Hybrid readiness;
- challenge modes remain question strategies, not recursive subagents.

No routing, scheduler, installer, or Codex agent configuration was modified.
