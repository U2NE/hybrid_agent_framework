# Requirements Clarification — OMC Deep Interview Port

## Source and scope

The clarification behavior is based on the pinned upstream:

- Yeachan-Heo/oh-my-claudecode
- commit `9fd35ece5d6de65b511bf43b55e42c499e4fc194`
- `skills/deep-interview/SKILL.md`
- related upstream skill tests/settings references.

This port keeps Hybrid's existing Node execution kernel, `.planning/` state, routing, scheduler, installer, and flat-dispatch architecture.

## Upstream OMC semantics confirmed and ported

- Default ambiguity threshold: `0.20`, with policy override support.
- Greenfield: `1 - (goal*0.40 + constraints*0.30 + criteria*0.30)`.
- Brownfield: `1 - (goal*0.35 + constraints*0.25 + criteria*0.25 + context*0.15)`.
- One-time Round 0 topology confirmation before ambiguity scoring.
- 1-6 top-level components; add/remove/merge/split/defer; deferred components excluded from ambiguity math.
- Brownfield repository facts are explored before user decision questions.
- Default ONE question per round.
- Every answer is followed by full re-scoring and weakest-target recomputation.
- Multi-component targeting considers all active component × dimension pairs.
- `lastTargetedComponentId` is used to avoid over-targeting one sibling when candidates are tied/similarly weak.
- Challenge strategies are prompt/question strategies, not recursive subagents:
  - Contrarian at round 4+, once.
  - Simplifier at round 6+, once.
  - Ontologist at round 8+ when ambiguity > 0.30, once.
- Stall rule: ambiguity remaining within ±0.05 for 3 rounds activates unused Ontologist early.
- Early exit allowed from round 3+ with warning.
- Round 10 soft warning.
- Round 20 hard cap.
- stop/cancel/abort pauses and preserves state.
- Normal mathematical success is ambiguity <= resolved threshold.
- A clear spec still requires explicit user approval before execution.

## Existing Hybrid behavior reused

Hybrid already supplied:

- `computeAmbiguity()` with the same OMC weights.
- `evaluateRequirements()`.
- per-component ambiguity with overall ambiguity equal to the maximum component ambiguity, preventing clear siblings from masking unclear ones.
- `chooseWeakestComponentDimension()`.
- `nextRequirementQuestion()`.
- canonical `hybrid-state/v1`.
- canonical Hybrid SPEC sections.
- approval-gated complex/ambiguous execution.

No second requirements engine was created.

## Hybrid-specific adaptations

These are not claimed to be upstream OMC behavior.

1. Durable state remains in Hybrid's existing `.planning/STATE.md` / `hybrid-state/v1`. OMC's `.omc/state` layout is not copied.
2. Clarification data is a backwards-compatible `clarification` field inside `hybrid-state/v1`.
3. Final provenance is appended to the existing Hybrid SPEC instead of reproducing OMC's file layout.
4. OMC says tied or “similarly weak” siblings should rotate, but does not define a numeric similarity distance in the skill. Hybrid uses a `0.05` score tolerance for deterministic rotation.
5. Hybrid retains its pre-existing required durable fields such as goal/topology/acceptance criteria. There are no arbitrary per-dimension hard floors.
6. Threshold precedence is exposed as a Node policy resolver (project > user > default) rather than copying Claude-specific settings file paths.
7. Ontology convergence is tracked separately from challenge mode: same-name entities are stable, same-type renames with >50% field overlap are changed, and stability is `(stable + changed) / current entities`. Low stability/new/changed entities can switch the next question to `ontology-stabilization` without consuming the one-shot Ontologist challenge mode. Hybrid still does not introduce a separate ontology/challenge agent tree.

## Completion states

- `spec-ready`: ambiguity gate passed; normal pass; SPEC must still await explicit user approval.
- `early-exit`: ambiguity remains high; warning SPEC may be crystallized, but `pass=false`.
- `hard-cap`: max rounds reached; warning SPEC may be crystallized, but `pass=false`.
- `paused`: explicit stop/cancel/abort; state remains resumable.

## Case D

Deterministic Case D begins from:

`알아서 로그인 기능 좋게 만들어줘`

Fixture result:

- Round 0: Auth Flow + Session Policy topology confirmation.
- Round 1: Auth Flow × Goal, ambiguity `0.605 -> 0.465`.
- Round 2: Session Policy × Criteria, `0.465 -> 0.305`.
- Round 3: Auth Flow × Criteria, `0.305 -> 0.180`.
- Final: `ambiguity=0.18 <= 0.20`, `pass=true`, `specReady=true`, approval remains pending.

The deterministic smoke asserts report contents, not merely process exit code.

A real interactive Case D is intentionally not auto-simulated. `--live D` reports `runtime-validation-pending` because real user answers are required.
