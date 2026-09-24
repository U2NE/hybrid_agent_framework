---
name: execute
description: Execute an approved plan using dependency waves, flat sibling workers, one-writer-per-file ownership, and Luna-default worker routing.
---

# Execute

Compute dependency waves from the approved PLAN. One writer per file per wave.

Independent tasks in the same wave are parallel-eligible sibling workers. Tasks with dependencies run in later waves. Same-file writers are serialized.

Give each implementer only a fresh context packet:
- Goal
- relevant files and interfaces
- acceptance criteria
- constraints and non-goals
- dependency outputs
- assigned ownership

Ordinary implementer work uses the Luna tier. Escalate only a genuinely complex debugging/judgment stage to Sol; recompute afterward so subsequent routine workers downshift to Luna.

Only the lead dispatches siblings. Workers do not spawn or delegate to other workers. The lead owns shared state, lifecycle, result collection, and integration.

If the requested explicit model is unavailable/rejected, retry that spawn without model/reasoning override and record the session-inheritance fallback.
