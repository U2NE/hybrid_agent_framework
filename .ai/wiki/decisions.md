---
title: Key Decisions
category: decision
tags: [state, codex, routing, decisions]
updated: 2026-09-25
---
# Key Decisions

- Flat dispatch is architectural: only the lead dispatches sibling workers and workers do not recursively delegate. The installer preserves a target-owned `max_depth` instead of using that key as the flatness mechanism.
- Model routing is Luna-first by effort: medium/high/xhigh/max are exhausted as appropriate before Sol escalation. Concrete IDs and effort values live only in the routing policy.
- Tier 0/1 avoid routine agent fan-out; expensive planning/testing/review/knowledge steps are conditional on evidence.
- Fresh worker context is reduced by section priority rather than raw prefix truncation; acceptance/constraints/verification remain protected.
- Parallel writers use worktrees only when side-effect/ownership risk warrants isolation; unavailable worktrees fall back to serialization.
- Routing is recomputed per stage, so a Sol planning/review stage can downshift to Luna for later routine work.
- Every Hybrid-controlled inference uses the explicit allowlisted model and reasoning effort selected by routing. Missing/unapproved overrides or runtime rejection fail closed; session/default model inheritance is prohibited.
- `.planning/` is canonical; this wiki is derived.
- State schema is `hybrid-state/v1`; unsupported/corrupt state fails closed.
- Same-file writers are serialized.
- Fix loops stop after three targeted repairs.

See [[index]] and [[architecture]].


- Planning consensus is tier/risk bounded: none for Tier 0/1, max 3 for ordinary complex review, max 5 for high-risk; a capped rejection never becomes execution approval.
- Final verification is goal-backward: every SPEC acceptance criterion must trace through a PLAN task and implementation evidence to fresh independent verification as VERIFIED/PARTIAL/MISSING.
- Security activation distinguishes strong trust-boundary changes from weak contextual words to avoid documentation/label false positives.
- Edge probes are applicability-aware gates rather than seven mandatory questions on every task.

- Authenticated A/B/C runtime smoke is semantic, not exit-code-only: output files plus runtime report evidence must pass the validator.
- Historical runtime probes confirmed Luna high/xhigh/max override request acceptance and, under the superseded policy, invalid-model rejection followed by no-override session inheritance. The current deterministic guard rejects invalid/missing model policy locally with no fallback execution; serving-model identity is intentionally not claimed as independently attested.
- OMC-style ontology convergence is separate from challenge mode: stable/renamed/new/removed entities drive an optional ontology-stabilization question strategy.
