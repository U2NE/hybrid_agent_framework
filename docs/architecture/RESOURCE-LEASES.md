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
3. the Lead must complete/reconcile those attempts, then release them only through a durable terminal transition; use `lease abort` for an explicit reconciled abort;
4. retry the same extension request;
5. publish the child graph under the normal graph-revision fence;
6. acquire a **new attempt** against the child graph before redispatch.

No active authorization is enlarged in place. This preserves the invariant that every dispatch authorization is bound to one immutable descriptor hash.

The **initial run graph binding** is part of the same revision-fenced state machine. `ExecutionRunStore.initializeGraph()` holds the lease-store graph revision fence while checking and publishing `GRAPH.json`, so concurrent identical G1 bindings converge to one commit plus replay, while conflicting descriptors produce one winner and one `GRAPH_FENCED` loser. The losing descriptor revision is not persisted. Initial binding, later graph advancement, and lease acquisition therefore cannot race through separate unfenced write paths.

Identical concurrent extension requests converge on one child descriptor. Different concurrent extensions cannot overwrite each other: the stale request receives `retry-required` and must recompute from the latest graph.

Runtime lease extension may add only semantic `resources`. It rejects caller-controlled `revisionId`, `files_modified`, `writes`, `reads`, `plan`, or `spec`. File-contract changes and product/API/schema/feature-scope/requirement/security semantic changes must go through the material revision approval flow. Material flags on an extension request return `user-approval-required` without mutating the graph.

## Evidence-bound release and recovery

A lease is not releasable merely because the worker returned, the Lead wants to reschedule, or the process restarted. Release authority comes from the durable transition ledger.

The only terminal transition kinds accepted for release are:

- `task_completed`;
- `recovered_task_completed`;
- `task_aborted_reconciled`.

The transition must be durably present in `TRANSITIONS.jsonl`, carry at least one evidence reference, and match the exact lease run, descriptor hash, graph revision, task, attempt, and effect policy. Terminal records persist the sealed graph `descriptorHash` as first-class identity. Before persistence, terminal commit holds the graph-revision fence and validates that descriptor hash, revision, executable agent node, and effect policy against the current sealed graph; a mismatched terminal record fails closed before it enters the ledger. Transition commits are serialized by a durable per-run `.transitions.lock` and persisted by atomic ledger replacement, so separate Lead/store instances cannot race an unchecked append. For each `(descriptorHash, graphRevision, task, attempt)`, at most one terminal outcome may exist; a competing `task_completed`, `recovered_task_completed`, or `task_aborted_reconciled` is fenced before persistence. Existing ledgers containing multiple terminal outcomes fail closed as corrupt. Recovery also requires the exact current descriptor/revision binding, so a completion from an older graph revision never marks the current revision complete. `ExecutionRunStore.releaseTaskLease()` reads that persisted transition, constructs a `hybrid-lease-release-proof/v1` bound to the lease descriptor and transition fingerprint, and only then calls the low-level lease store.

The low-level `ResourceLeaseStore.release()` rejects null, arbitrary result objects, or proofs bound to another task/attempt/graph. It independently re-reads `TRANSITIONS.jsonl` and requires the proof fingerprint to match the exact persisted terminal record before an active lease can be released. Released lease records are revalidated against that ledger on later store loads, so missing or corrupted terminal evidence fails closed after restart as well. **Raw token-only/null-result release is forbidden.** Exact replay of the same verified proof is idempotent; a contradictory proof is fenced.

For a task that must stop without successful completion, use an explicit reconciled abort. `ExecutionRunStore.abortTaskLease()` / `hybrid lease abort` requires at least one reconciliation evidence reference, commits `task_aborted_reconciled`, then releases through the same proof path. A plain cancellation string is not release authority.

Current-workspace and worktree evidence are **sources for the terminal transition**, not substitutes for it. For example:

```text
workspace-guard complete
  -> commit task_completed with workspace-guard:<guard-id> evidence
  -> lease release using that transition id
```

or, when abandoning the attempt:

```text
reconcile/discard observed effects
  -> lease abort with evidence refs
  -> task_aborted_reconciled
  -> evidence-bound release
```

This means a graph revision barrier cannot be cleared by dropping a lease without durable reconciliation evidence.

## CLI

Installed projects may use:

```text
node .hybrid/bin/hybrid.mjs lease acquire <run-id> <task-id> <attempt-id> [project-root]
node .hybrid/bin/hybrid.mjs lease verify <run-id> <authorization.json> [project-root]
node .hybrid/bin/hybrid.mjs lease extend <run-id> <extension.json> [project-root]
node .hybrid/bin/hybrid.mjs lease release <run-id> <authorization.json> <terminal-transition-id> [project-root]
node .hybrid/bin/hybrid.mjs lease abort <run-id> <authorization.json> <abort.json> [project-root]
node .hybrid/bin/hybrid.mjs lease list <run-id> [project-root]
```

A mutating Hybrid worker is not authorized to start without a current active dispatch authorization for its sealed task attempt. When that task is scheduled in the shared current workspace rather than a detached worktree, the same authorization must also open the repository-global current-workspace mutation guard before spawn. Guard completion must succeed first; then commit the terminal completion/reconciliation transition; then perform evidence-bound lease release. See `WORKSPACE-MUTATION-GUARD.md`.
