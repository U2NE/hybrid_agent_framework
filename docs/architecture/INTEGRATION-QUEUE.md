# Durable integration queue

Parallel workers may execute concurrently, but their writes are integrated through exactly one deterministic queue.

## Ordering

The scheduler orders ready tasks lexicographically by task ID. Worktree integration independently re-establishes that same lexical task-ID order from the wave handle, so worker completion order cannot change the final patch order.

Before integration, every result must match exactly one worktree task. The patch file is re-read and its byte length and SHA-256 hash are checked against the observed handoff. A changed patch is rejected before it can touch the main workspace.

## Single writer

Each queue has a PID-owned lock. Concurrent integration callers serialize on that lock. After the first caller finishes, the next caller replays the completed journal rather than applying the patches again.

Dead PID locks are reclaimed. A malformed/ownerless lock is reclaimed only after a stale-age bound so an active integration cannot be stolen casually.

## Durable journal

The journal is stored under the repository Git common directory, not in the working tree:

```text
.git/hybrid/integration/<queue-id>.json
```

The queue ID is a SHA-256 digest of:

- base commit;
- run/revision/graph identity carried by the worktree wave;
- deterministic integration order;
- for every ordered result: task ID, worker/agent identity when available, `attemptId`, non-secret `leaseId`, patch hash, patch size, and changed-file set.

Because `attemptId` and `leaseId` are part of each ordered result, changing execution authority for an otherwise identical patch produces a different queue identity. The lease token and full dispatch authorization are not persisted in the integration journal.

Each applied record binds the task, `attemptId`, `leaseId`, worker attribution, patch, base commit, changed files, and an observed SHA-256 workspace snapshot. Journal validation requires the applied prefix to match the descriptor's exact task/attempt/lease order. The snapshot covers both the full binary tracked diff against `HEAD` and a deterministic manifest of every untracked file or symlink, including a content/target hash, so newly created files cannot disappear from crash-recovery evidence.

## Authority binding

Worktree ownership starts with `hybrid-worktree-owner/v2`, which binds run/revision/graph/task, `attemptId`, non-secret `leaseId`, worker identity, and base commit before mutation. Result collection re-reads that owner record and carries the same `attemptId`/`leaseId` into the observed patch handoff.

Recovery/completion lookup through `findCompletedWorktreeIntegration()` is stricter than a generic queue replay. It requires an exact non-empty run/revision/graph/task/`attemptId`/`leaseId` identity, finds the matching applied record only in a completed journal, and fails closed if multiple journals claim the same task-attempt-lease. The completed receipt is accepted only while repository `HEAD` still equals the journal base commit and the current main-workspace hash still equals the recorded final workspace hash.

That completed `hybrid-worktree-integration-receipt/v1` evidence is the authority consumed by terminal transition validation. For `worktree` isolation, both ordinary `task_completed` and `recovered_task_completed` require the exact completed integration evidence before the terminal record can persist and the lease can be released. A detached patch, worker return, or queue journal that does not match the active task attempt/lease is not completion authority.

## Crash windows

Before a patch is applied, the journal is fsynced with status `applying` and the pre-apply workspace hash.

After restart:

- if the workspace still equals the pre-apply hash, the patch was not applied and execution resumes normally;
- if the workspace changed and `git apply --reverse --check` proves the exact in-flight patch is present, the framework records that patch as recovered and continues without duplicate application;
- if neither state can be proven, integration stops with `WORKTREE_INTEGRATION_RECONCILE_REQUIRED`.

A completed queue is replayable only while the current workspace hash matches its recorded final snapshot.

## Conflict behavior

Patch conflicts or apply failures roll the integration workspace back to the original base commit and persist a `rolled-back` journal state. There is no silent conflict resolution.

Unexplained workspace drift is different: the framework does not destroy evidence by resetting it. It fails closed for reconciliation.

This gives the parallel execution path a deterministic boundary:

```text
parallel worktrees
  -> owner-bound observed patch handoffs (task + attemptId + leaseId)
  -> deterministic durable integration queue
  -> completed integration receipt
  -> terminal transition authority
  -> evidence-bound lease release
```
