---
name: execute
description: Execute an approved plan using dependency waves, flat sibling workers, one-writer-per-file ownership, and Luna-default worker routing.
---

# Execute

Compute dependency waves from the approved PLAN. One writer per file per wave. The Lead never performs an Implementer-owned file mutation itself; it must spawn the planned Implementer, and if that spawn is unavailable or fails it stops without mutating that task's files.

The Lead's normal installed execution preparation is `prepareExecutionWithProvenance()` from `.hybrid/core/orchestrator/index.mjs`. It reuses pure `prepareExecution()` and automatically persists the generated decision trace through the Lead-owned decision writer. Finalize classification/task normalization first; if inspection is needed, use pure `prepareExecution()` because it performs zero provenance I/O. Then call `prepareExecutionWithProvenance()` exactly once for the selected execution revision. Do not persist trial preparations and do not manually replay `decisionTrace` into `decisions.jsonl`.

For every actual spawn/complete/integration action, the Lead uses `createOrchestrationEventWriter()` or `createLeadProvenanceSession()` from the installed core. When a decision object already exists, use the session's `writeActionForDecision(decision, event)` binding instead of manually copying its decision ID or routed model metadata. At the end of the run, the Lead audits persisted decisions/events/actor artifacts with installed `auditDecisionTrace()` and writes `audit.json` through `writeAuditArtifact()` or the Lead provenance session. Public `appendRuntimeEvent()` is passive-only and rejects action-bearing central records. Each implementation worker writes one bounded completion self-report using only `createActorArtifactWriter()` for its own `actors/<agentRunId>.jsonl`; self-reports remain `reported`. Use a native worker/thread ID when directly observed, otherwise explicitly mark a framework-logical identity.

Independent tasks in the same wave are parallel-eligible sibling workers. Tasks with dependencies run in later waves. Same-file writers are serialized. For multiple parallel writers, evaluate isolation: precise tiny ownership may share the workspace; lockfiles/generated outputs/migrations/formatters/low ownership confidence use worktree isolation when available, otherwise safe serialization. When worktree mode is selected, the lead owns the lifecycle through the Hybrid worktree bridge: create one detached worktree per writer, run each worker with that worktree as cwd, collect only declared-owner patches, fail closed on integration conflict, verify the integrated main workspace, then remove/prune every temporary worktree.

Give each implementer only a fresh context packet:
- Goal
- relevant files and interfaces
- acceptance criteria
- constraints and non-goals
- dependencies and dependency outputs
- resolved decisions
- required verification
- assigned ownership

Worker context is budgeted and markdown-aware: preserve Goal, Acceptance Criteria, Constraints, relevant files/interfaces, dependencies, decisions, and required verification before lower-priority history/log prose. When multiple sibling quality workers need the same immutable repository/SPEC/PLAN facts, `runQualityClosure()` routes context construction through `buildWorkerContextWithCache()`; cache use is conditional on a real reuse opportunity, excludes role-private reasoning, adds no LLM call, and falls back to ordinary `buildWorkerContext()` on miss/corruption/write failure. Ordinary implementer work starts on the appropriate Luna effort and only enters Sol after Luna is insufficient.

If independent QA finds a blocking acceptance defect, return only a targeted repair packet to the implementation owner. Do not replay the full QA transcript. Proof acquisition is not an implementation task and does not create another agent.

Only the lead dispatches siblings. Workers do not spawn or delegate to other workers. Every worker dispatch carries the policy-derived explicit model and reasoning effort; the linked decision/action/actor metadata records `requestedModel` and `requestedReasoningEffort`. The lead owns shared state, lifecycle, result collection, and integration.

The lead is the sole writer of the run's central orchestration decisions and events. Link actual dispatch and integration actions to their decisions when available. Workers return bounded metadata and may write only their own actor artifact through the worker-scoped API; they never append to the central decisions log or write another worker's artifact. Record observable task, wave, ownership, routing, and action metadata only. Never record chain-of-thought, hidden reasoning, prompts, conversation text, source text, or diffs.

Decision provenance explains the selected control-flow action; runtime events record what actually happened; actor artifacts describe bounded worker activity; the deterministic audit checks agreement between decisions and actions.

If the requested routed model/effort is unavailable or rejected, fail closed. Do not retry without model/reasoning overrides and do not inherit the Codex session/default model.
