---
name: clarify
description: OMC-style iterative requirements clarification with Round 0 topology lock, scout-first brownfield context, mathematical ambiguity gating, challenge modes, and durable resume state.
---

# Clarify

Use this skill for complex or ambiguous requests. Do not interview Tier 0 trivial work or a fully specified bounded task.

This skill ports the clarification semantics of pinned OMC deep-interview into Hybrid's existing Node/state architecture. Do not add separate recursive interview agents.

## Threshold

Resolve the ambiguity threshold before scoring. Default: `0.20`.

Project/user policy may override it. The mathematical readiness gate is:

```
ambiguity <= resolved threshold
```

Do not add Hybrid-specific per-dimension hard floors.

## Brownfield rule

For brownfield work, Scout the repository before asking the user about repository facts.

- facts → inspect the repository;
- decisions / intent → ask the user.

When a question depends on a discovered repository fact, cite the path/symbol/pattern in the question and ask the user to decide how the new requirement should relate to it.

## Round 0 — topology gate

Before any ambiguity scoring:

1. Analyze the request plus Scout evidence.
2. Enumerate 1-6 top-level components that can succeed/fail independently.
3. Ask exactly one topology-confirmation question.
4. Allow add/remove/merge/split/defer.
5. Persist the confirmed topology and deferrals.
6. Lock topology. Round 0 runs once.

Deferred components remain recorded but are excluded from ambiguity math.

## Interview loop

Default: ONE user question per round.

For every round after Round 0:

1. Score every active topology component independently.
2. Calculate ambiguity using the existing Hybrid/OMC weights.
3. Select the globally weakest active component × required dimension pair.
4. If sibling components are tied or similarly weak, avoid repeatedly targeting `lastTargetedComponentId`.
5. State why that pair is the bottleneck.
6. Ask one targeted question.
7. Record the answer.
8. Update the working spec and durable clarification state.
9. Re-score all active components.
10. Recompute ambiguity and the weakest pair from the new scores.
11. Repeat while ambiguity is above threshold.

Never reuse the first round's scores or weakest target after an answer changes the spec.

Per-round durable data should include:

- round number;
- target component;
- target dimension;
- why it was weakest;
- question;
- answer;
- scores before/after;
- ambiguity before/after;
- challenge mode, when any.

## Challenge modes

These alter question strategy only. They do not spawn a recursive agent tree.

- Round 4+: Contrarian, once.
- Round 6+: Simplifier, once.
- Round 8+ while ambiguity > 0.30: Ontologist, once.
- If ambiguity stalls within ±0.05 of the same score for 3 rounds, activate unused Ontologist mode early to reframe.

Track used challenge modes in durable state.

## Stop conditions

- Normal success: ambiguity <= threshold and required spec fields exist.
- Round 10: soft warning; offer continue vs explicit early exit.
- Round 20: hard cap. Crystallize a warning/risk spec but do NOT report normal clarification success.
- Round 3+: if the user explicitly says enough/proceed/build, allow early exit with current ambiguity, remaining gaps, and execution risk. This is not a normal pass.
- stop/cancel/abort: stop immediately and preserve resumable state.

## SPEC crystallization and approval

On normal pass, crystallize the accumulated result into the existing Hybrid SPEC structure:

- Goal
- Topology
- Constraints
- Non-goals
- Acceptance Criteria
- Resolved assumptions
- Technical context
- Relevant code
- Edge cases

Also record clarification provenance: final ambiguity, threshold/source, clarity scores, round count, confirmed topology, and deferred components.

For complex/ambiguous work:

```
clarity pass
→ durable SPEC
→ pending user approval
→ planning/execution only after approval
```

Early-exit/hard-cap specs must preserve unresolved gaps and risk and must not be labeled normal pass.

## Resume

Persist clarification data in the existing `hybrid-state/v1` record:

- active/status;
- project type;
- threshold/source;
- topology + deferrals;
- rounds/history;
- current scores and ambiguity;
- last targeted component;
- challenge modes used;
- ontology snapshots when present;
- next expected action.

Do not create a second canonical state store.
