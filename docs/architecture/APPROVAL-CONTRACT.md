# User approval contract

Hybrid treats user approval as an authority boundary, not as another model verdict.

## Scope

The approval contract applies only when an execution path requires explicit user approval. Tier 0/1 fast paths that do not require approval remain unchanged.

When approval is required, the framework first computes an exact subject:

- `runId`;
- `specHash`;
- normalized `planHash`.

The user-facing approval action must refer to that subject. After the user explicitly approves it, the host/orchestration layer may create a `hybrid-user-approval/v1` receipt.

## What the receipt proves

The receipt provides deterministic integrity binding between the recorded approval event and the exact run/spec/plan content that may be sealed into an execution graph.

It does **not** independently authenticate the human identity. Human authenticity comes from the surrounding trusted interaction or host UI that records the explicit user action. Therefore Lead and worker agents must never synthesize a receipt on their own and treat that as user approval.

## Execution graph binding

Execution graph v3 embeds the complete receipt and sets `approvalScopeHash` to the receipt hash.

Sealing fails closed when:

- no receipt is present;
- the receipt was modified after creation;
- the receipt belongs to a different run;
- the SPEC content or supplied SPEC hash differs from the approved SPEC;
- the normalized plan differs from the approved plan;
- a caller attempts to substitute a different `planHash` or `specHash`.

Restart validation repeats the same receipt/subject checks.

## Revisions after approval

Non-material execution adjustments may remain inside the same approved semantic scope. Examples include conflict-free resource-lease expansion, retry bookkeeping, task rescheduling, and other operational changes that do not alter product meaning. Such child graph revisions preserve the original receipt.

A new explicit user approval is required when a revision changes any material semantic boundary currently classified by `materialRevisionReasons()`, including:

- product behavior;
- public API;
- schema meaning;
- feature scope;
- requirement removal;
- security posture;
- an explicitly marked material revision.

A material request does not mutate the sealed graph before the new approval is received.

### Material revision protocol

Material changes use a two-step proposal/apply protocol.

`proposeMaterialRevision(parentGraph, revisedPlan, input)`:

- validates the current sealed parent graph;
- requires at least one explicit material reason;
- computes a new approval subject from the revised normalized PLAN and revised/retained SPEC;
- rejects a "material" proposal whose SPEC and PLAN hashes are both unchanged;
- binds the proposal to the exact parent descriptor/revision, child revision, reason set, SPEC binding mode, and approval subject through `hybrid-material-revision-proposal/v1` plus `proposalHash`;
- returns `user-approval-required` without changing the durable current graph.

After a real user approves that exact subject, `sealApprovedMaterialRevision()`:

- revalidates proposal integrity;
- recomputes the PLAN/SPEC subject to detect changes after proposal;
- requires a fresh receipt identity rather than reusing the parent approval;
- seals a child graph whose `parentDescriptorHash` points to the current parent;
- records a material-revision amendment with the proposal hash, reason codes, prior hashes, prior approval scope, and new approval scope.

Publishing the child still goes through `ExecutionRunStore.advanceGraph()`. Therefore any active lease on the parent graph blocks publication until the in-flight execution is reconciled and the lease is durably released.

Installed projects expose the same boundary as:

```text
hybrid revision propose <run-id> <input.json> [project-root]
hybrid revision apply   <run-id> <input.json> [project-root]
```

`revision apply` consumes an externally created user approval receipt; it does not create one.

## Operational rule

The normal sequence is:

```text
prepareExecution()
  -> approvalSubject
  -> explicit user approval
  -> createUserApprovalReceipt()
  -> prepareExecution({ executionApproved: true, approvalReceipt })
  -> sealed execution graph v3
```

This keeps user authority separate from model capability: a stronger planner or reviewer may explain options, but it cannot mint semantic approval on the user's behalf.
