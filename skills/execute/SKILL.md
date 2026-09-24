---
name: execute
description: Execute an approved plan using dependency waves, flat sibling workers, one-writer-per-file ownership, and Luna-default worker routing.
---

# Execute

Compute dependency waves from the approved PLAN. One writer per file per wave.

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

Only the lead dispatches siblings. Workers do not spawn or delegate to other workers. The lead owns shared state, lifecycle, result collection, and integration.

If the requested explicit model is unavailable/rejected, retry that spawn without model/reasoning override and record the session-inheritance fallback.
