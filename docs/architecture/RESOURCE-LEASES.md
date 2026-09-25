# Pre-execution resource leases

Hybrid uses a three-layer mutation safety model:

1. planning-time file/read-write/semantic-resource conflict analysis;
2. **durable pre-execution resource leases** immediately before worker dispatch;
3. post-execution observed Git diff and patch-hash validation.

The lease layer is the runtime guard between a sealed execution graph and an actual mutating worker.

## Storage

For run `<runId>`, leases are stored at:

```text
.planning/runs/<runId>/LEASES.json
```

The store is mode `0600`. Mutations are protected by a short-lived cross-process `.leases.lock` acquired with create-exclusive semantics. A stale store lock may be removed after the bounded stale-lock threshold, but **task leases themselves never expire just because a process disappeared**.

An active task lease surviving restart means “execution state must be reconciled,” not “the worker is definitely dead.”

## Dispatch authorization

`ResourceLeaseStore.acquire(graph, taskId, attemptId)` validates the sealed graph and returns a `hybrid-dispatch-authorization/v1` object bound to:

- run ID;
- graph revision and descriptor hash;
- task ID and attempt ID;
- role and effect policy;
- capability grant;
- exact task file/read/write/resource contract;
- durable lease ID and token.

The same exact active acquisition is idempotent and returns the same authorization. Reusing a task attempt for a different request is fenced. Reacquiring an already released attempt is rejected to prevent accidental duplicate execution.

`assertAuthorization()` requires the durable lease to still be active and checks the authorization against both the stored lease and the current sealed task contract.

## Conflict behavior

A lease acquisition never silently waits for a task conflict. Planning should already have produced a conflict-free runnable wave; the lease layer is the final race-condition guard.

If another active lease conflicts by file read/write access or semantic resource, acquisition fails with `LEASE_CONFLICT`.

Two separate runtime processes can therefore race to acquire the same resource and exactly one may win. Disjoint task/resource contracts may acquire concurrently.

## Graph revision fence

A graph revision changes the descriptor hash that every dispatch authorization is bound to. Therefore `ExecutionRunStore.advanceGraph()` and lease acquisition share the same durable `.leases.lock` boundary.

Inside that lock, graph advancement re-reads the current graph and active lease set. Replaying the exact current descriptor is allowed, but a real child revision is rejected with `GRAPH_ADVANCE_ACTIVE_LEASES` while any task lease is active. After every active lease has been durably released/reconciled, the child graph may advance.

This is intentionally stronger than a separate “check then write”: holding the same lock across active-lease inspection and graph persistence removes the acquire-vs-revision TOCTOU window.

## Runtime resource extension barrier

An already-running task never has its dispatch authorization or sealed task contract mutated in place.

If execution discovers an additional **non-material semantic resource** requirement, the Lead calls:

```text
node .hybrid/bin/hybrid.mjs lease extend <run-id> <extension.json> [project-root]
```

with an input such as:

```json
{
  "taskId": "implement-auth",
  "resources": [
    { "key": "contract:session", "mode": "exclusive" }
  ]
}
```

The runtime protocol is a graph-revision barrier:

1. compute a deterministic non-material child graph from the current sealed graph;
2. if any old-revision lease is active, return `drain-required` and leave the current graph unchanged;
3. the Lead must complete/reconcile or explicitly abort those attempts and durably release their leases;
4. retry the same extension request;
5. publish the child graph under the normal graph-revision fence;
6. acquire a **new attempt** against the child graph before redispatch.

No active authorization is enlarged in place. This preserves the invariant that every dispatch authorization is bound to one immutable descriptor hash.

Identical concurrent extension requests converge on one child descriptor. Different concurrent extensions cannot overwrite each other: the stale request receives `retry-required` and must recompute from the latest graph.

Runtime lease extension may add only semantic `resources`. It rejects caller-controlled `revisionId`, `files_modified`, `writes`, `reads`, `plan`, or `spec`. File-contract changes and product/API/schema/feature-scope/requirement/security semantic changes must go through the material revision approval flow. Material flags on an extension request return `user-approval-required` without mutating the graph.

## Release and recovery

Release requires the lease token and is fingerprinted by its result. Replaying the same release is idempotent. Releasing the same lease with a contradictory result is fenced.

Do not release an active lease merely because the controlling process restarted. First reconcile durable transitions and observed worktree evidence. Release after completion, explicit abort reconciliation, or another durable outcome has been established.

## CLI

Installed projects may use:

```text
node .hybrid/bin/hybrid.mjs lease acquire <run-id> <task-id> <attempt-id> [project-root]
node .hybrid/bin/hybrid.mjs lease verify <run-id> <authorization.json> [project-root]
node .hybrid/bin/hybrid.mjs lease list <run-id> [project-root]
node .hybrid/bin/hybrid.mjs lease release <run-id> <lease-id> <lease-token> [project-root]
```

A mutating Hybrid worker is not authorized to start without a current active dispatch authorization for its sealed task attempt. When that task is scheduled in the shared current workspace rather than a detached worktree, the same authorization must also open the repository-global current-workspace mutation guard before spawn; guard completion must succeed before task completion is accepted and the lease is released. See `WORKSPACE-MUTATION-GUARD.md`.
