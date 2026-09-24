---
name: hybrid
description: Codex-first autonomous development front door with flat dispatch, Luna-default routing, conditional Sol escalation, and durable planning state.
---

# Hybrid Front Door

Use this skill when the user asks to implement, change, fix, refactor, or add a feature.

## Entry sequence

1. Read AGENTS.md, .planning/PROJECT.md, and .planning/STATE.md.
2. Classify the task:
   - Tier 0 trivial: implement directly, then lightweight verification without routine multi-agent QA fan-out.
   - Tier 1 bounded: Scout only when repository discovery is needed, then implement → verifier; Planner/Tester/Code Reviewer are conditional on actual structure/behavior/logic risk.
   - Tier 2 complex: scout, spec-lite, approval, planning council, execution waves, independent QA/review.
   - Tier 3 ambiguous: scout, run the iterative `$clarify` deep-interview loop (Round 0 topology → one weakest-pair question per round → re-score until the ambiguity threshold), crystallize a durable SPEC pending explicit approval, then continue on the Tier 2 path.
3. Never ask the user for facts available from the repo.
4. Use .planning as the only canonical state.
5. Compute dependency waves and serialize same-file writers.
6. Keep the lead thin. Only the lead spawns sibling Hybrid agents; workers never recursively delegate.
7. Before each agent spawn, use the Hybrid model-routing decision:
   - normal stage: Luna tier;
   - choose Luna medium/high/xhigh/max from stage difficulty; use Sol only after Luna max is insufficient or for exceptionally difficult/critical unresolved reasoning;
   - after a Sol-only stage, recompute the next stage independently so normal implementer/tester/documentation work can downshift to Luna.
8. If Codex rejects or cannot use the explicit routed model, retry that spawn once without model/reasoning override and record session-inheritance fallback. Never guess a replacement model ID.
9. After an integrated snapshot exists, close quality through the generic `runQualityClosure()` primitive exported by `.hybrid/core/orchestrator/index.mjs` (or `core/orchestrator/index.mjs` in the framework repo). Supply only the QA lanes already selected by the existing tier/risk pipeline. Tier 0/1 fast paths remain unchanged unless their existing risk gates already require deeper QA.
10. `runQualityClosure()` enforces evidence-gated completion: real blocking defects return a targeted packet to the implementation owner for at most three cycles; missing proof becomes a structured proof gap, raw proof is acquired deterministically, the Verifier semantically reassesses the exact evidence ID, and only then can the completion gate PASS. Do not spawn a QE, Evidence Collector, or Repair agent.
11. Reuse deterministic shared context snapshots only when the same repository/SPEC/PLAN facts would otherwise be reconstructed across workers. Cache miss/corruption/storage failure falls back to normal context construction and never changes correctness.
12. Passive runtime events are derived best-effort artifacts only; they add no agent/model call and never become canonical state.
13. Integrate, run full tests, then update durable docs and the derived wiki.

## Worker context

Give workers only:
- Goal
- Relevant files and interfaces
- Acceptance criteria
- Constraints
- Dependency outputs
- Assigned file ownership
- The lead-selected model tier/model, when an explicit override is being used

Do not dump the full conversation into every worker.

## Approval gate

Complex or ambiguous work must have an approved SPEC before implementation unless the user explicitly requests a safe, bounded direct change.
