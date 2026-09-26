# IMPLEMENTATION — Hardening

The hardening phase started with four verified behavioral checkpoints and then continued with execution-authority hardening on `architecture-v2-hardening`.

## Behavioral and runtime checkpoints

- `eb54670` — Luna effort ladder, classifier improvements, safe installer routing.
- `c32bee1` — small-task fan-out reduction, context reduction, isolation policy.
- `b6c2096` — planning consensus and evidence quality gates.
- `e51aa11` — ontology convergence and semantic/authenticated runtime validation.

## Execution-authority checkpoints

- `69ba210` / `b501963` — sealed execution graph plus exact explicit user-approval binding.
- `92db607` / `c848429` — deterministic role capability contracts and durable pre-execution resource leases.
- `5475ccf` / `c75532c` / `487a5e6` — scheduler isolation, worktree ownership evidence, and the durable deterministic integration queue.
- `38cfb4e` / `4a902ff` / `e69982d` — graph revision fencing, lease-extension revision barriers, and fenced initial graph binding.
- `a26c5d6` — repository-global current-workspace mutation guard.
- `c45458f` / `ff42483` / `20b5b81` / `66c24c3` — evidence-bound lease release, durable transition serialization, descriptor-bound terminals, and exact dispatch-authority enforcement.
- `8768e2a` — worktree recovery bound to completed durable integration evidence for the exact task attempt and lease.
- `233a831` — `hybrid-exec-graph/v4` seals deterministic `isolationMode` and propagates it through lease/task-contract/dispatch authority; ordinary worktree completion is fenced by the same integration evidence as recovered completion.
- `01e83e2` — durable state/verification/README documentation synchronized to the v4 authority boundary.

## Current authority path

`explicit user approval -> sealed graph v4 -> deterministic isolation -> durable lease -> dispatch authorization -> guarded mutation/worktree integration -> durable terminal transition -> evidence-bound lease release`

For worktree execution, ownership and integration records carry task `attemptId` and non-secret `leaseId`. `findCompletedWorktreeIntegration()` requires exact run/revision/graph/task/attempt/lease identity and only accepts a completed journal whose recorded base HEAD and final workspace hash still match. Both ordinary `task_completed` and recovery `recovered_task_completed` are subject to that integration fence; recovery completion is rejected for `current-workspace`.

## Verification scope

- E/F: authenticated semantic PASS.
- G/H: authenticated semantic PASS through the framework-source generic quality primitive; not by themselves installed-Lead attestation.
- I: authenticated semantic PASS through an installed Lead invoking the installed production primitive.
- J: authenticated revised Tier 0 decision-provenance PASS with Implementer-owned mutation and a clean audit.
- K: authenticated parallel decision-provenance PASS with one parallel parent, two Implementer children, disjoint ownership, and a clean audit.
- D: deterministic fixture verified, but real user-interactive execution remains intentionally pending.
- Backend serving-model identity is not independently attested; evidence establishes accepted explicit model/effort requests only.

No replacement framework, second state engine, or unrelated execution architecture was introduced.
