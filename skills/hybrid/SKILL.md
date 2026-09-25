---
name: hybrid
description: Codex-first autonomous development front door with flat dispatch, Luna-default routing, conditional Sol escalation, and durable planning state.
---

# Hybrid Front Door

Use this skill when the user asks to implement, change, fix, refactor, or add a feature.

## Entry sequence

1. Read AGENTS.md, .planning/PROJECT.md, and .planning/STATE.md.
2. Classify the task:
   - Tier 0 trivial: dispatch one Implementer, then perform lightweight verification without routine multi-agent QA fan-out. The Lead MUST NOT replace the Implementer for normal task-owned file mutation; if the required Implementer cannot be spawned, fail closed without mutating its files.
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
8. Every Hybrid-controlled inference must use the explicit allowlisted model and reasoning effort resolved by routing. Session/default inheritance is prohibited. Pass both values explicitly on every worker spawn, and record bounded `requestedModel` / `requestedReasoningEffort` metadata in the linked decision/action/actor evidence. If Codex rejects or cannot use that routed override, fail closed without a model-less retry or arbitrary substitution.
9. For real installed execution, BEFORE any task-owned file mutation use `prepareExecutionWithProvenance()` from `.hybrid/core/orchestrator/index.mjs` as the mandatory normal preparation path. `prepareExecution()` remains the pure deterministic calculation API for analysis, unit tests, preflight, and any non-persisted normalization/classification inspection needed before execution. Finalize the executable input first, then call the wired wrapper exactly once for that execution revision; do not persist trial preparations or manually replay `decisionTrace`. Normalize tasks with owner, files_modified, depends_on, and a bounded worker identity before that call.
10. Central action-bearing runtime events must go through the Lead-owned `createOrchestrationEventWriter()` or the thin `createLeadProvenanceSession()` facade. When an action belongs to an existing decision, retain/load that decision object and use the session's `writeActionForDecision(decision, event)` binding; never manually transcribe its decision ID or routed model metadata. Public `appendRuntimeEvent()` is passive-only and must not be used for `decisionId`/`action`/central ownership records. Workers never receive the central writer.
11. Give each worker a bounded `runId`, task/wave identity, assigned ownership, and worker identity. Each implementation worker writes one bounded completion self-report to its own `actors/<agentRunId>.jsonl` through `createActorArtifactWriter()`; that self-report remains `attribution: reported`. If no native Codex worker ID is exposed, label a framework-assigned logical ID as such rather than claiming it is observed native identity.
12. Preserve the canonical Tier 0 fast path: after the Implementer returns, the Lead performs deterministic lightweight verification, records the linked lightweight-verification and completion decisions/events, then audits the run. Do not invoke routine Tester/Reviewer/Verifier fan-out merely for provenance. When the existing tier/risk path requires generic quality closure, use `runQualityClosure()` from `.hybrid/core/orchestrator/index.mjs` (or `core/orchestrator/index.mjs` in the framework repo) with only the QA lanes already selected by that path.
13. `runQualityClosure()` enforces evidence-gated completion and automatically uses Lead-owned decision/event writers on the default path. Real blocking defects return a targeted packet to the implementation owner for at most three cycles; missing proof becomes a structured proof gap, raw proof is acquired deterministically, the Verifier semantically reassesses the exact evidence ID, and only then can the completion gate PASS. Do not spawn a QE, Evidence Collector, or Repair agent.
14. Reuse deterministic shared context snapshots only when the same repository/SPEC/PLAN facts would otherwise be reconstructed across workers. Cache miss/corruption/storage failure falls back to normal context construction and never changes correctness.
15. Passive runtime events are derived best-effort artifacts only; they add no agent/model call and never become canonical state.
16. Keep decision provenance passive and structured: the lead owns orchestration decisions and the central decisions log; workers return bounded metadata and can write only their own actor artifact. Workers never write central decisions.
17. Record observable facts, stable policy identifiers, selected control-flow decisions, intended actions, linked actual actions, and evidence references. Never record chain-of-thought, hidden reasoning, scratchpads, prompts, conversations, source text, or diffs.
18. Keep the artifacts distinct: runtime events record what happened, decision provenance records why Hybrid selected a control-flow action, actor artifacts record bounded worker activity, and the deterministic audit checks whether decisions and actions agree.
19. Before declaring provenance-backed execution complete, the Lead reads the run decisions/events/actor artifacts, runs installed `auditDecisionTrace()`, and persists the result through `writeAuditArtifact()` (or the equivalent Lead provenance session audit method). The audit is derived evidence, not canonical state.
20. Integrate, run full tests, then update durable docs and the derived wiki.

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
