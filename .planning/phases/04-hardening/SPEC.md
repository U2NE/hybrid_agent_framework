# SPEC — Hybrid Hardening

## Goal

Reduce orchestration cost for small work while strengthening planning/review/verification evidence for complex work, without replacing the existing Hybrid architecture, while making execution authority durable and fail-closed across scheduling, dispatch, mutation, integration, completion, recovery, and restart.

## Acceptance Criteria

- Luna effort ladder is used before Sol escalation.
- Role names alone do not force Sol.
- Installer preserves target-owned agents and max_depth.
- Tier 0/1 avoid routine QA fan-out.
- Worker context reduction preserves critical sections.
- Risky parallel writers use worktree isolation or safe serialization; current-workspace writers are protected by the repository-global mutation guard.
- Approved execution is sealed as `hybrid-exec-graph/v4`, including deterministic scheduler-selected `isolationMode` for every executable task.
- A caller-supplied isolation plan must exactly match a fresh deterministic scheduler calculation or sealing fails closed.
- Durable leases and dispatch authorizations preserve the exact run/revision/descriptor/task/attempt/capability/effect/isolation contract; caller-side authority substitution fails closed.
- Initial graph binding, graph advancement, and lease acquisition are revision-fenced; an active old-revision lease blocks incompatible graph publication.
- New terminal transitions require the exact active durable dispatch authorization and lease, and competing terminal outcomes for one descriptor/revision/task/attempt are fenced.
- Lease release requires an evidence-bearing durable terminal transition rather than token-only completion.
- Worktree `task_completed` and `recovered_task_completed` require completed durable integration evidence bound to the exact run/revision/graph/task/`attemptId`/`leaseId`, with repository HEAD and final workspace hash still matching.
- `recovered_task_completed` is valid only for worktree-isolated execution; current-workspace recovery cannot manufacture a recovered completion.
- Planning consensus is bounded and cannot false-approve.
- Security activation avoids weak keyword false positives.
- Every acceptance criterion can trace through plan, implementation, and verification.
- Ontology convergence is available only when domain scope is unstable.
- Runtime smoke validates semantics, not exit code.
- Authenticated A/B/C are recorded honestly; E/F reach authenticated semantic PASS; G/H reach authenticated semantic PASS through the framework-source generic quality primitive; I reaches authenticated semantic PASS through an installed Lead and installed production primitive; revised J/K reach authenticated provenance PASS with clean audits.
- Genuine user-interactive Case D and independent backend serving-model attestation remain intentionally unclaimed.
- Existing regression suite remains green.
